import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RewardCheckIn, RewardWallet } from '@prisma/client';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { RootConfig } from '../config/configuration';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  cycleDayForStreak,
  nextPeriodStartUtc,
  nextStreakDays,
  resolveCheckInTransition,
  toPeriodKey,
} from './reward-period.util';
import {
  CHECK_IN_BONUS_DAY,
  CHECK_IN_CYCLE_LENGTH,
  CHECK_IN_REWARD_CURVE,
  DEV_GRANT_MAX_POINTS,
  findRedemptionOffer,
  LEDGER_PAGE_SIZE_DEFAULT,
  LEDGER_PAGE_SIZE_MAX,
  REWARD_ENTITLEMENT_SOURCE,
  REWARD_REASONS,
  REWARD_REDEMPTION_OFFERS,
  REWARD_SOURCE_TYPES,
  REWARD_TASK_DEFINITIONS,
} from './rewards.constants';
import { RewardsWalletService, WalletView } from './rewards-wallet.service';
import {
  CheckInResponseDto,
  DailyCheckInDayDto,
  DailyCheckInDto,
  RedeemResponseDto,
  RewardLedgerPageDto,
  RewardRedemptionOfferDto,
  RewardsSnapshotDto,
  RewardTaskDto,
  RewardWalletDto,
} from './rewards.types';

/**
 * Work unit "REWARDS BACKEND FOUNDATION": the product layer of the rewards
 * domain — what a user is allowed to earn, when, and what they may spend it
 * on. The mechanical "record this movement safely" half lives in
 * `RewardsWalletService`, which is the only thing in this codebase that
 * writes a balance.
 *
 * THE THREE PROPERTIES THIS CLASS IS RESPONSIBLE FOR:
 *
 * 1. THE SERVER OWNS "TODAY". Every date in here comes from `toPeriodKey`
 *    against the configured service timezone. Nothing reads a date, a
 *    timezone, or a clock from the request — a client-derived boundary lets
 *    a user harvest several days of check-ins in one evening by moving the
 *    phone clock (mobile `docs/rewards-domain-contract.md` §4).
 * 2. THE SERVER OWNS THE AMOUNT. No endpoint accepts a balance, a delta, or
 *    a "points earned" figure. The client sends INTENT ("check in", "redeem
 *    offer X with key K"); every number is resolved here from
 *    `rewards.constants.ts` (§4, "Server-authoritative balance").
 * 3. A DAY CAN BE CLAIMED ONCE. The check-in's idempotency key is
 *    SERVER-DERIVED from the calendar date, so it is not something a client
 *    can vary to buy a second payout.
 */
@Injectable()
export class RewardsService {
  private readonly logger = new Logger(RewardsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: RewardsWalletService,
    private readonly entitlements: EntitlementsService,
    private readonly configService: ConfigService<RootConfig>,
  ) {}

  /**
   * The full Rewards Center view model. One read-only call — it creates no
   * wallet row and no check-in row, so polling it is free of side effects.
   */
  async getSnapshot(userId: string): Promise<RewardsSnapshotDto> {
    const now = new Date();
    const [walletView, checkIn] = await Promise.all([
      this.wallet.readWallet(userId),
      this.prisma.rewardCheckIn.findUnique({ where: { userId } }),
    ]);

    return {
      wallet: toWalletDto(walletView),
      dailyCheckIn: this.buildDailyCheckIn(checkIn, now),
      watchTime: null,
      tasks: this.buildTasks(),
      redemptions: this.buildRedemptions(walletView.balancePoints),
    };
  }

  /**
   * Claims today's check-in.
   *
   * IDEMPOTENT BY CONSTRUCTION. The ledger key is
   * `DAILY_CHECK_IN:<periodKey>` — derived here from the server clock and
   * the service timezone, never supplied by the caller. A double-tapped
   * button, a retried request after a dropped connection, and a malicious
   * client looping the endpoint all produce the SAME key, so the second and
   * subsequent attempts take `appendEntry`'s replay branch: no ledger row,
   * no points, no streak movement, and a 200 describing the state that
   * already existed.
   *
   * WHY THE WHOLE THING IS ONE TRANSACTION. The streak counters in
   * `RewardCheckIn` and the payment in `RewardLedgerEntry` describe the same
   * event. If the ledger append committed and the streak update did not, the
   * user would be paid for a day the server does not believe they claimed —
   * and would then be able to claim it again tomorrow with a key that is
   * already taken, silently getting nothing. Both writes commit together or
   * neither does.
   */
  async checkIn(userId: string): Promise<CheckInResponseDto> {
    const timezone = this.timezone();
    const now = new Date();
    const today = toPeriodKey(now, timezone);

    const result = await this.prisma.$transaction(async (tx) => {
      // FIRST STATEMENT: take this account's `User` row lock, before reading
      // anything. The award below is computed FROM the streak row, so that
      // read has to happen inside the critical section — reading it first and
      // locking afterwards would let a concurrent check-in commit in between
      // and leave this transaction deciding the payout from stale state.
      // `appendEntry` re-takes the same lock, which is a no-op here.
      await this.wallet.lockAccount(tx, userId);

      const previous = await tx.rewardCheckIn.findUnique({ where: { userId } });
      const transition = resolveCheckInTransition(
        previous?.lastCheckInDate ?? null,
        today,
      );
      const streak = nextStreakDays(
        transition,
        previous?.currentStreakDays ?? 0,
      );
      const cycleDay = cycleDayForStreak(streak);

      const append = await this.wallet.appendEntry(tx, {
        userId,
        deltaPoints: CHECK_IN_REWARD_CURVE[cycleDay - 1],
        reason: REWARD_REASONS.DAILY_CHECK_IN,
        sourceType: REWARD_SOURCE_TYPES.CHECK_IN,
        sourceId: today,
        // SERVER-DERIVED, and this is the whole anti-double-claim control:
        // one calendar date maps to exactly one key, so a day can be paid at
        // most once however the request is repeated. Nothing the caller
        // sends contributes to it.
        idempotencyKey: `${REWARD_REASONS.DAILY_CHECK_IN}:${today}`,
        metadata: { periodKey: today, streakDay: streak, cycleDay },
      });

      if (append.replayed) {
        // Already checked in today. Nothing was written — return the streak
        // row untouched so the response describes the state that exists.
        return { append, checkIn: previous, awarded: 0 };
      }

      const checkIn = await tx.rewardCheckIn.upsert({
        where: { userId },
        create: {
          userId,
          currentStreakDays: streak,
          longestStreakDays: streak,
          totalCheckInDays: 1,
          lastCheckInDate: today,
          lastCheckInAt: now,
        },
        update: {
          currentStreakDays: streak,
          longestStreakDays: Math.max(streak, previous?.longestStreakDays ?? 0),
          totalCheckInDays: { increment: 1 },
          lastCheckInDate: today,
          lastCheckInAt: now,
        },
      });

      return { append, checkIn, awarded: append.entry.deltaPoints };
    });

    if (!result.append.replayed) {
      this.logger.log(
        `Reward check-in credited ${result.awarded} points (period ${today})`,
      );
    }

    return {
      awardedPoints: result.awarded,
      alreadyCheckedIn: result.append.replayed,
      ledgerEntryId: result.append.entry.id,
      wallet: toWalletDto(fromWalletRow(result.append.wallet)),
      dailyCheckIn: this.buildDailyCheckIn(result.checkIn, now),
    };
  }

  /**
   * Paginated ledger history, newest first — the "transaction history" the
   * ledger exists to make possible.
   *
   * CURSOR, NOT OFFSET. An append-only table that grows while a user pages
   * through it makes `skip`/`take` shift entries between pages; a cursor
   * anchored to a row does not. Ordering is `(createdAt desc, id desc)` so
   * entries written in the same millisecond still have a total order —
   * without the `id` tiebreak the cursor could loop or skip on a burst.
   */
  async getLedger(
    userId: string,
    limit: number | undefined,
    cursor: string | undefined,
  ): Promise<RewardLedgerPageDto> {
    const take = Math.min(
      limit ?? LEDGER_PAGE_SIZE_DEFAULT,
      LEDGER_PAGE_SIZE_MAX,
    );

    const rows = await this.prisma.rewardLedgerEntry.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // Fetch one extra row to learn whether another page exists without a
      // second COUNT query.
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const page = rows.slice(0, take);
    const hasMore = rows.length > take;

    return {
      entries: page.map((entry) => ({
        id: entry.id,
        deltaPoints: entry.deltaPoints,
        reason: entry.reason,
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        balanceAfter: entry.balanceAfter,
        createdAt: entry.createdAt.toISOString(),
        metadata: entry.metadata,
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * Spends points on a catalog offer and grants the premium it buys.
   *
   * THE DEBIT AND THE GRANT ARE ONE TRANSACTION. The mobile contract §5 is
   * unambiguous: "the point debit and the entitlement grant are one atomic
   * transaction: both succeed or neither does. A client must never be able
   * to activate an entitlement locally." So the ledger debit, the
   * `RewardRedemption` receipt and `EntitlementsService.grantTimedPremium`
   * all run inside the same `$transaction`. A failure anywhere rolls back
   * every part — the user is never charged for premium they did not get, and
   * never given premium they did not pay for.
   *
   * PREMIUM IS GRANTED THROUGH THE EXISTING ENTITLEMENT SYSTEM, not a
   * rewards-specific one. `grantTimedPremium` is the same writer the payment
   * flow uses; only the `source` string differs, which keeps "how did this
   * account become premium?" answerable from one table.
   *
   * IDEMPOTENCY IS CLIENT-KEYED HERE, unlike check-in — redeeming the same
   * offer twice is legitimate, so only the client can distinguish a retry
   * from a second purchase. A key reused for a DIFFERENT offer is refused
   * (`REWARD_IDEMPOTENCY_KEY_REUSED`) rather than replayed, because
   * answering offer B's request with offer A's receipt would report a
   * purchase the caller never made.
   */
  async redeem(
    userId: string,
    offerId: string,
    idempotencyKey: string,
  ): Promise<RedeemResponseDto> {
    const offer = findRedemptionOffer(offerId);

    if (!offer) {
      throw new AppException(
        AppErrorCode.REWARD_OFFER_NOT_FOUND,
        'Unknown redemption offer',
        HttpStatus.NOT_FOUND,
      );
    }

    if (!offer.isEnabled) {
      throw new AppException(
        AppErrorCode.REWARD_OFFER_UNAVAILABLE,
        'This redemption is not available yet',
        HttpStatus.CONFLICT,
      );
    }

    const existing = await this.prisma.rewardRedemption.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
    });

    if (existing) {
      if (existing.offerId !== offerId) {
        throw new AppException(
          AppErrorCode.REWARD_IDEMPOTENCY_KEY_REUSED,
          'This idempotency key was already used for a different offer',
          HttpStatus.CONFLICT,
        );
      }
      return {
        redemptionId: existing.id,
        offerId: existing.offerId,
        costPoints: existing.costPoints,
        grantsDays: existing.grantsDays,
        status: existing.status as RedeemResponseDto['status'],
        replayed: true,
        wallet: toWalletDto(await this.wallet.readWallet(userId)),
        entitlementExpiresAt:
          existing.entitlementExpiresAt?.toISOString() ?? null,
      };
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // Debit first. `appendEntry` takes the `User` lock as its first
      // statement (canonical lock order) and refuses an overdrawing debit
      // with `INSUFFICIENT_REWARD_POINTS`, so an unaffordable redemption
      // fails before any entitlement work happens.
      const append = await this.wallet.appendEntry(tx, {
        userId,
        deltaPoints: -offer.costPoints,
        reason: REWARD_REASONS.VIP_REDEMPTION,
        sourceType: REWARD_SOURCE_TYPES.REDEMPTION,
        sourceId: offer.id,
        idempotencyKey: `${REWARD_REASONS.VIP_REDEMPTION}:${idempotencyKey}`,
        metadata: { offerId: offer.id, grantsDays: offer.grantsDays },
      });

      const grant = await this.entitlements.grantTimedPremium(
        tx,
        userId,
        offer.grantsDays,
        REWARD_ENTITLEMENT_SOURCE,
      );

      if (!grant) {
        // `grantTimedPremium` returns null only when the `User` row vanished
        // — impossible here, because `appendEntry` already locked it in this
        // same transaction and would have thrown `USER_NOT_FOUND` first.
        // Throwing rolls the debit back rather than charging for nothing.
        throw new AppException(
          AppErrorCode.USER_NOT_FOUND,
          'User not found',
          HttpStatus.NOT_FOUND,
        );
      }

      const redemption = await tx.rewardRedemption.create({
        data: {
          userId,
          offerId: offer.id,
          // Snapshotted, so retuning the catalog never rewrites this receipt.
          costPoints: offer.costPoints,
          grantsDays: offer.grantsDays,
          status: 'FULFILLED',
          idempotencyKey,
          ledgerEntryId: append.entry.id,
          entitlementId: grant.id,
          entitlementExpiresAt: grant.expiresAt,
        },
      });

      return { append, redemption, grant };
    });

    this.logger.log(
      `Reward redemption ${result.redemption.id} spent ${offer.costPoints} points for ${offer.grantsDays}d premium`,
    );

    return {
      redemptionId: result.redemption.id,
      offerId: result.redemption.offerId,
      costPoints: result.redemption.costPoints,
      grantsDays: result.redemption.grantsDays,
      status: 'FULFILLED',
      replayed: false,
      wallet: toWalletDto(fromWalletRow(result.append.wallet)),
      entitlementExpiresAt: result.grant.expiresAt.toISOString(),
    };
  }

  /**
   * DEV-ONLY (gated by `DevToolsGuard`): credits points directly.
   *
   * Exists so the local Android demo can exercise redemption without first
   * checking in for forty consecutive days. It is a real ledger movement
   * with its own `ADJUSTMENT` reason and a `DEV_TOOL` source, NOT a
   * back-door balance write — so even the demo's shortcut is auditable and
   * reconciles, and the wallet has exactly one writer in every environment.
   */
  async devGrantPoints(
    userId: string,
    points: number,
    idempotencyKey: string,
  ): Promise<RewardWalletDto> {
    if (
      !Number.isInteger(points) ||
      points <= 0 ||
      points > DEV_GRANT_MAX_POINTS
    ) {
      throw new AppException(
        AppErrorCode.REWARD_LEDGER_INVALID_DELTA,
        `Dev grant must be an integer between 1 and ${DEV_GRANT_MAX_POINTS}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const append = await this.prisma.$transaction((tx) =>
      this.wallet.appendEntry(tx, {
        userId,
        deltaPoints: points,
        reason: REWARD_REASONS.ADJUSTMENT,
        sourceType: REWARD_SOURCE_TYPES.DEV_TOOL,
        sourceId: 'dev-grant',
        idempotencyKey: `${REWARD_SOURCE_TYPES.DEV_TOOL}:${idempotencyKey}`,
        metadata: { grantedPoints: points },
      }),
    );

    return toWalletDto(fromWalletRow(append.wallet));
  }

  /** DEV-ONLY: ledger-vs-projection consistency report. */
  reconcile(userId: string) {
    return this.wallet.reconcile(userId);
  }

  /**
   * Builds the check-in view model, including the 7-day cycle strip.
   *
   * The strip's states are derived, never stored: days before the pending
   * one are `CLAIMED` (they are the streak that got the user here), the
   * pending one is `TODAY` — or `CLAIMED` if today's claim already
   * happened — and the rest are `UPCOMING`. A restarted streak resolves to
   * cycle day 1, so a returning user correctly sees an empty strip rather
   * than credit for days they missed.
   */
  private buildDailyCheckIn(
    checkIn: RewardCheckIn | null,
    now: Date,
  ): DailyCheckInDto {
    const timezone = this.timezone();
    const today = toPeriodKey(now, timezone);
    const currentStreak = checkIn?.currentStreakDays ?? 0;
    const transition = resolveCheckInTransition(
      checkIn?.lastCheckInDate ?? null,
      today,
    );
    const isTodayClaimed = transition === 'already-claimed';

    // When today is already claimed the strip highlights the day just paid;
    // otherwise it highlights the day the next claim would pay.
    const highlightedStreak = isTodayClaimed
      ? currentStreak
      : nextStreakDays(transition, currentStreak);
    const highlightedDay = cycleDayForStreak(highlightedStreak);

    const days: DailyCheckInDayDto[] = [];
    for (let day = 1; day <= CHECK_IN_CYCLE_LENGTH; day += 1) {
      days.push({
        day,
        rewardPoints: CHECK_IN_REWARD_CURVE[day - 1],
        state: resolveDayState(day, highlightedDay, isTodayClaimed),
        isBonus: day === CHECK_IN_BONUS_DAY,
      });
    }

    return {
      currentStreakDays: currentStreak,
      longestStreakDays: checkIn?.longestStreakDays ?? 0,
      totalCheckInDays: checkIn?.totalCheckInDays ?? 0,
      todayRewardPoints: CHECK_IN_REWARD_CURVE[highlightedDay - 1],
      isTodayClaimed,
      days,
      isClaimSupported: true,
      periodKey: today,
      timezone,
      resetsAt: nextPeriodStartUtc(today, timezone).toISOString(),
    };
  }

  private buildTasks(): RewardTaskDto[] {
    return REWARD_TASK_DEFINITIONS.map((task) => ({
      id: task.id,
      type: task.type,
      rewardPoints: task.rewardPoints,
      status: task.status,
      ...(task.socialPlatform ? { socialPlatform: task.socialPlatform } : {}),
      isClaimSupported: task.isClaimSupported,
      unsupportedReason: task.unsupportedReason,
    }));
  }

  /**
   * Availability is computed SERVER-SIDE against the authoritative balance,
   * so a client cannot enable a redeem button by lying about what it can
   * afford — and even if it tried, `redeem` re-checks under a row lock.
   */
  private buildRedemptions(balancePoints: number): RewardRedemptionOfferDto[] {
    return REWARD_REDEMPTION_OFFERS.map((offer) => ({
      id: offer.id,
      costPoints: offer.costPoints,
      grantsDays: offer.grantsDays,
      availability: !offer.isEnabled
        ? ('COMING_SOON' as const)
        : balancePoints >= offer.costPoints
          ? ('AVAILABLE' as const)
          : ('INSUFFICIENT_POINTS' as const),
      isRedeemSupported: offer.isEnabled,
    }));
  }

  private timezone(): string {
    return this.configService.get('rewards', { infer: true })!.timezone;
  }
}

function resolveDayState(
  day: number,
  highlightedDay: number,
  isTodayClaimed: boolean,
): DailyCheckInDayDto['state'] {
  if (day < highlightedDay) {
    return 'CLAIMED';
  }
  if (day === highlightedDay) {
    return isTodayClaimed ? 'CLAIMED' : 'TODAY';
  }
  return 'UPCOMING';
}

function fromWalletRow(row: RewardWallet): WalletView {
  return {
    balancePoints: row.balancePoints,
    lifetimeEarnedPoints: row.lifetimeEarnedPoints,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

function toWalletDto(view: WalletView): RewardWalletDto {
  return {
    balancePoints: view.balancePoints,
    lifetimeEarnedPoints: view.lifetimeEarnedPoints,
    // Always true: this value came out of the server-side ledger projection.
    // The mobile fixture set hardcoded `false`, and this flag flipping to
    // `true` is how the client knows it is rendering real, spendable points.
    isServerAuthoritative: true,
    updatedAt: view.updatedAt?.toISOString() ?? null,
    version: view.version,
  };
}
