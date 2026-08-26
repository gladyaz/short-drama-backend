import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RewardMissionClaim } from '@prisma/client';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { RootConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { nextPeriodStartUtc } from './reward-period.util';
import { RewardsWalletService } from './rewards-wallet.service';
import { RewardsWatchService } from './rewards-watch.service';
import {
  findWatchMissionDefinition,
  ONE_TIME_MISSION_PERIOD_KEY,
  REWARD_MISSION_TYPES,
  REWARD_REASONS,
  REWARD_SOURCE_TYPES,
  WATCH_MISSION_DEFINITIONS,
  WatchMissionDefinition,
} from './rewards.constants';
import {
  MissionClaimResponseDto,
  MissionOpenResponseDto,
  RewardTaskDto,
  RewardWalletDto,
} from './rewards.types';
import {
  findSocialMissionDefinition,
  ResolvedSocialMission,
  resolveSocialMissionCatalog,
  SOCIAL_MISSION_MIN_DWELL_SECONDS,
  SocialMissionCatalog,
} from './social-missions.constants';

/**
 * Work unit "REWARDS V1 EARN AND SPEND": the two earn paths the foundation
 * slice deliberately left unbuilt — social follow missions and watch
 * milestones — and the only writer of `RewardMissionClaim`.
 *
 * ---------------------------------------------------------------------------
 * TWO MISSION FAMILIES, ONE STATE MACHINE
 *
 *   SOCIAL   one-time, forever. Open the profile, come back, confirm.
 *            Evidence: `USER_CONFIRMED`. Ledger key
 *            `EXTERNAL_SOCIAL_ACTION:<missionId>` — no period, so a second
 *            claim is impossible for the life of the account.
 *
 *   WATCH    resets every reward day. Progress is a COUNT of distinct
 *            episodes this backend authorised playback for today.
 *            Evidence: `SERVER_OBSERVED`. Ledger key
 *            `WATCH_MILESTONE:<missionId>:<periodKey>` — so yesterday's
 *            claim does not block today's, and today's cannot be made twice.
 *
 * ---------------------------------------------------------------------------
 * WHAT STOPS FARMING, IN ORDER OF LOAD-BEARINGNESS
 *
 * 1. THE SERVER-DERIVED LEDGER KEY. Nothing a client sends contributes to it.
 *    One social mission pays once per account, one watch milestone pays once
 *    per account per reward day, and the `@@unique([userId, idempotencyKey])`
 *    index enforces that inside the same `User` row lock every other reward
 *    movement takes. This is the control; everything below is shape.
 * 2. THE SERVER OWNS EVERY NUMBER. The reward comes from the catalog by
 *    mission id, the progress count comes from a `COUNT(*)` this service
 *    runs, and the reward day comes from the service timezone. There is no
 *    request field anywhere in this file that influences a payout.
 * 3. THE OPEN RECORD. A social claim without a prior `open` is refused, so a
 *    client cannot confirm a link the server never handed it.
 * 4. THE DWELL WINDOW. The smallest server-side expression of "you went and
 *    came back". A script can wait five seconds; this is stated as shape,
 *    not sold as security. See `SOCIAL_MISSION_MIN_DWELL_SECONDS`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SERVICE REFUSES TO CLAIM
 *
 * A social claim means "the account holder says they did it". It does NOT
 * mean a follow happened, that the same person did it, or that it outlasted
 * collecting the points — no platform in the catalog exposes a check that
 * could establish any of those. Every social task therefore ships
 * `verification: 'USER_CONFIRMED'`, and the ledger reason is
 * `EXTERNAL_SOCIAL_ACTION`. See `social-missions.constants.ts` for the full
 * argument.
 */
@Injectable()
export class RewardsMissionsService {
  private readonly logger = new Logger(RewardsMissionsService.name);

  /**
   * Resolved ONCE, in the constructor, from `process.env` — the
   * `AdsConfigService` precedent. This provider is a singleton, so that is
   * once per process, and the catalog cannot drift mid-process into a state
   * where two requests disagree about which missions exist.
   */
  private readonly socialCatalog: SocialMissionCatalog;

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: RewardsWalletService,
    private readonly watch: RewardsWatchService,
    private readonly configService: ConfigService<RootConfig>,
  ) {
    this.socialCatalog = resolveSocialMissionCatalog(process.env);

    for (const { definition, rejection } of this.socialCatalog.rejected) {
      // Unreachable in a process that booted — `env.validation.ts` refuses
      // to start with a malformed value. Logged rather than ignored so that
      // if it ever IS reachable, the mission's absence is explained instead
      // of being a silent gap an operator has to guess at. The VARIABLE is
      // named; its value is not echoed.
      this.logger.warn(
        `${definition.envKey} is set but unusable (${rejection}); the ` +
          `"${definition.id}" mission will not be offered.`,
      );
    }
  }

  /**
   * The mission tiles for the Rewards Center, with this user's state on each.
   *
   * ONE ROUND TRIP FOR THE STATE, not one per mission: a single query pulls
   * every relevant claim row, and a single `COUNT` gives today's watch
   * progress. A per-tile query would make the snapshot's cost grow with the
   * catalog.
   */
  async buildMissionTasks(userId: string, now: Date): Promise<RewardTaskDto[]> {
    const periodKey = this.watch.currentPeriodKey(now);

    const [claims, episodesStarted] = await Promise.all([
      this.prisma.rewardMissionClaim.findMany({
        where: {
          userId,
          // Social rows live under the one-time sentinel; watch rows under
          // today's date. Yesterday's watch rows are deliberately not read —
          // they describe a mission window that has closed.
          periodKey: { in: [ONE_TIME_MISSION_PERIOD_KEY, periodKey] },
        },
      }),
      this.watch.countEpisodesStarted(userId, periodKey),
    ]);

    const byMissionId = new Map(claims.map((row) => [row.missionId, row]));
    const resetsAt = nextPeriodStartUtc(periodKey, this.timezone());

    const socialTasks = this.socialCatalog.missions.map((mission) =>
      toSocialTask(mission, byMissionId.get(mission.definition.id) ?? null),
    );

    const watchTasks = WATCH_MISSION_DEFINITIONS.map((mission) =>
      toWatchTask(
        mission,
        byMissionId.get(mission.id) ?? null,
        episodesStarted,
        resetsAt,
      ),
    );

    return [...socialTasks, ...watchTasks];
  }

  /**
   * Hands the caller a social mission's destination URL and records that it
   * did.
   *
   * THE URL COMES FROM THE SERVER, NOT THE SNAPSHOT THE CLIENT IS HOLDING.
   * The snapshot carries it too (so the tile can be rendered), but this call
   * is what a tap must go through — it is where the open is recorded, and a
   * claim with no open is refused. Returning the URL here also means a
   * client working from a stale snapshot follows the CURRENT destination
   * rather than one from a previous configuration.
   */
  async openMission(
    userId: string,
    missionId: string,
    now = new Date(),
  ): Promise<MissionOpenResponseDto> {
    const mission = this.requireConfiguredSocialMission(missionId);

    const claim = await this.prisma.rewardMissionClaim.upsert({
      where: {
        userId_missionId_periodKey: {
          userId,
          missionId,
          periodKey: ONE_TIME_MISSION_PERIOD_KEY,
        },
      },
      create: {
        userId,
        missionId,
        missionType: REWARD_MISSION_TYPES.SOCIAL,
        periodKey: ONE_TIME_MISSION_PERIOD_KEY,
        destinationUrl: mission.destinationUrl,
        openedAt: now,
        openCount: 1,
      },
      update: {
        // Re-snapshotted, so the recorded destination is the one the user was
        // actually sent to on THIS open rather than the one from the first.
        destinationUrl: mission.destinationUrl,
        openedAt: now,
        openCount: { increment: 1 },
      },
    });

    return {
      missionId,
      destinationUrl: mission.destinationUrl,
      openedAt: now.toISOString(),
      claimableAfter: new Date(
        now.getTime() + SOCIAL_MISSION_MIN_DWELL_SECONDS * 1000,
      ).toISOString(),
      task: toSocialTask(mission, claim),
    };
  }

  /**
   * Claims a mission. Dispatches on which family the id belongs to; an id in
   * neither is a 404 that pays nothing.
   */
  async claimMission(
    userId: string,
    missionId: string,
    now = new Date(),
  ): Promise<MissionClaimResponseDto> {
    if (findSocialMissionDefinition(missionId)) {
      return this.claimSocialMission(userId, missionId, now);
    }

    const watchMission = findWatchMissionDefinition(missionId);

    if (watchMission) {
      return this.claimWatchMission(userId, watchMission, now);
    }

    throw new AppException(
      AppErrorCode.REWARD_MISSION_NOT_FOUND,
      'Unknown mission',
      HttpStatus.NOT_FOUND,
    );
  }

  /**
   * Pays a social mission once, ever.
   *
   * THE PRE-TRANSACTION CHECKS ARE A COURTESY, NOT THE CONTROL. Reading the
   * claim row to answer "not opened yet" and "opened a moment ago" gives a
   * client a precise reason instead of a generic failure — but two
   * concurrent claims can both pass them. What neither can pass is the ledger
   * key inside the transaction: `appendEntry` takes the `User` lock first, so
   * the second one finds the first's entry and takes the replay branch. The
   * money question is answered under the lock; these checks only shape the
   * message.
   */
  private async claimSocialMission(
    userId: string,
    missionId: string,
    now: Date,
  ): Promise<MissionClaimResponseDto> {
    const mission = this.requireConfiguredSocialMission(missionId);

    const existing = await this.prisma.rewardMissionClaim.findUnique({
      where: {
        userId_missionId_periodKey: {
          userId,
          missionId,
          periodKey: ONE_TIME_MISSION_PERIOD_KEY,
        },
      },
    });

    if (!existing?.openedAt) {
      throw new AppException(
        AppErrorCode.REWARD_MISSION_NOT_STARTED,
        'Open the profile link before confirming this mission',
        HttpStatus.CONFLICT,
      );
    }

    // Skipped for an already-claimed mission: re-opening the profile resets
    // `openedAt`, and refusing a replay for being "too soon" would answer a
    // harmless repeat tap with an error instead of the idempotent no-op the
    // rest of this domain returns.
    if (!existing.claimedAt) {
      const elapsedMs = now.getTime() - existing.openedAt.getTime();

      if (elapsedMs < SOCIAL_MISSION_MIN_DWELL_SECONDS * 1000) {
        throw new AppException(
          AppErrorCode.REWARD_MISSION_TOO_SOON,
          'Give the profile page a moment before confirming',
          HttpStatus.CONFLICT,
        );
      }
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const append = await this.wallet.appendEntry(tx, {
        userId,
        deltaPoints: mission.definition.rewardPoints,
        reason: REWARD_REASONS.EXTERNAL_SOCIAL_ACTION,
        sourceType: REWARD_SOURCE_TYPES.SOCIAL_MISSION,
        sourceId: missionId,
        // SERVER-DERIVED and PERIOD-FREE: one account, one mission, one
        // payment, for the life of the account.
        idempotencyKey: `${REWARD_REASONS.EXTERNAL_SOCIAL_ACTION}:${missionId}`,
        metadata: {
          missionId,
          platform: mission.definition.platform,
          // Recorded on the ledger entry itself so an auditor reading the
          // movement sees the evidence class without having to know how
          // social missions work.
          verification: 'USER_CONFIRMED',
          destinationUrl: mission.destinationUrl,
        },
      });

      if (append.replayed) {
        return { append, claim: existing, awarded: 0 };
      }

      const claim = await tx.rewardMissionClaim.update({
        where: { id: existing.id },
        data: {
          claimedAt: now,
          awardedPoints: mission.definition.rewardPoints,
          ledgerEntryId: append.entry.id,
        },
      });

      return { append, claim, awarded: append.entry.deltaPoints };
    });

    if (!result.append.replayed) {
      this.logger.log(
        `Social mission "${missionId}" credited ${result.awarded} points ` +
          '(user-confirmed external action, not a verified follow)',
      );
    }

    return {
      missionId,
      awardedPoints: result.awarded,
      alreadyClaimed: result.append.replayed,
      ledgerEntryId: result.append.entry.id,
      wallet: toWalletDto(result.append.wallet),
      task: toSocialTask(mission, result.claim),
    };
  }

  /**
   * Pays a watch milestone once per reward day.
   *
   * THE PROGRESS COUNT IS RE-READ INSIDE THE TRANSACTION, deliberately. The
   * pre-check outside is what produces a precise
   * `REWARD_MISSION_NOT_COMPLETE`; the re-read under the account lock is what
   * makes the payment correct — without it, a request that arrived while the
   * user was one episode short could pay on a count that was already stale
   * when it was read.
   */
  private async claimWatchMission(
    userId: string,
    mission: WatchMissionDefinition,
    now: Date,
  ): Promise<MissionClaimResponseDto> {
    const periodKey = this.watch.currentPeriodKey(now);
    const resetsAt = nextPeriodStartUtc(periodKey, this.timezone());

    const started = await this.watch.countEpisodesStarted(userId, periodKey);

    if (started < mission.requiredEpisodes) {
      throw new AppException(
        AppErrorCode.REWARD_MISSION_NOT_COMPLETE,
        `Start ${mission.requiredEpisodes} episodes today to claim this mission`,
        HttpStatus.CONFLICT,
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // Taken before the count is re-read, for the reason
      // `RewardsService.checkIn` documents: the payout decision is made FROM
      // this read, so it has to happen inside the critical section.
      await this.wallet.lockAccount(tx, userId);

      const confirmed = await tx.rewardWatchCredit.count({
        where: { userId, periodKey },
      });

      if (confirmed < mission.requiredEpisodes) {
        throw new AppException(
          AppErrorCode.REWARD_MISSION_NOT_COMPLETE,
          `Start ${mission.requiredEpisodes} episodes today to claim this mission`,
          HttpStatus.CONFLICT,
        );
      }

      const append = await this.wallet.appendEntry(tx, {
        userId,
        deltaPoints: mission.rewardPoints,
        reason: REWARD_REASONS.WATCH_MILESTONE,
        sourceType: REWARD_SOURCE_TYPES.WATCH_MISSION,
        sourceId: mission.id,
        // SERVER-DERIVED and PERIOD-BOUND: once per account per reward day.
        idempotencyKey: `${REWARD_REASONS.WATCH_MILESTONE}:${mission.id}:${periodKey}`,
        metadata: {
          missionId: mission.id,
          periodKey,
          requiredEpisodes: mission.requiredEpisodes,
          episodesStarted: confirmed,
          verification: 'SERVER_OBSERVED',
        },
      });

      // On a replay the claim row already exists and already carries the
      // original award; `update: {}` leaves it exactly as it was rather than
      // restamping `claimedAt` with the time of the retry.
      const claim = await tx.rewardMissionClaim.upsert({
        where: {
          userId_missionId_periodKey: {
            userId,
            missionId: mission.id,
            periodKey,
          },
        },
        create: {
          userId,
          missionId: mission.id,
          missionType: REWARD_MISSION_TYPES.WATCH,
          periodKey,
          claimedAt: now,
          awardedPoints: mission.rewardPoints,
          // The funding entry, whether this call created it or replayed it.
          // Reaching `create` on a replay means the derived row went missing
          // while its immutable ledger entry survived — pointing the rebuilt
          // row back at that entry is the repair, not `null`.
          ledgerEntryId: append.entry.id,
        },
        update: append.replayed
          ? {}
          : {
              claimedAt: now,
              awardedPoints: mission.rewardPoints,
              ledgerEntryId: append.entry.id,
            },
      });

      return {
        append,
        claim,
        awarded: append.replayed ? 0 : append.entry.deltaPoints,
        confirmed,
      };
    });

    return {
      missionId: mission.id,
      awardedPoints: result.awarded,
      alreadyClaimed: result.append.replayed,
      ledgerEntryId: result.append.entry.id,
      wallet: toWalletDto(result.append.wallet),
      task: toWatchTask(mission, result.claim, result.confirmed, resetsAt),
    };
  }

  /**
   * The mission, or the right refusal.
   *
   * THREE DISTINCT ANSWERS, deliberately: an id that is not in the catalog is
   * 404 (a client bug or an injection attempt); a watch mission asked to
   * "open" is `REWARD_MISSION_NOT_OPENABLE` (nothing to open); a real social
   * mission this deployment has not configured is
   * `REWARD_MISSION_UNAVAILABLE` (the tile exists, the URL does not).
   * Collapsing them into one error would leave a client unable to tell "you
   * asked for something that does not exist" from "we have not turned that
   * on yet".
   */
  private requireConfiguredSocialMission(
    missionId: string,
  ): ResolvedSocialMission {
    const configured = this.socialCatalog.missions.find(
      (mission) => mission.definition.id === missionId,
    );

    if (configured) {
      return configured;
    }

    if (findSocialMissionDefinition(missionId)) {
      throw new AppException(
        AppErrorCode.REWARD_MISSION_UNAVAILABLE,
        'This mission is not available in this deployment',
        HttpStatus.CONFLICT,
      );
    }

    if (findWatchMissionDefinition(missionId)) {
      throw new AppException(
        AppErrorCode.REWARD_MISSION_NOT_OPENABLE,
        'This mission has nothing to open — it progresses as you watch',
        HttpStatus.CONFLICT,
      );
    }

    throw new AppException(
      AppErrorCode.REWARD_MISSION_NOT_FOUND,
      'Unknown mission',
      HttpStatus.NOT_FOUND,
    );
  }

  private timezone(): string {
    return this.configService.get('rewards', { infer: true })!.timezone;
  }
}

/**
 * A social tile.
 *
 * `verification: 'USER_CONFIRMED'` is not optional and is not conditional. It
 * ships on every social task, in every state, so no client can render one of
 * these as a verified follow even by accident.
 */
function toSocialTask(
  mission: ResolvedSocialMission,
  claim: RewardMissionClaim | null,
): RewardTaskDto {
  const isClaimed = claim?.claimedAt != null;

  return {
    id: mission.definition.id,
    type: 'SOCIAL_FOLLOW',
    rewardPoints: mission.definition.rewardPoints,
    status: isClaimed
      ? 'COMPLETED'
      : claim?.openedAt
        ? 'CLAIMABLE'
        : 'AVAILABLE',
    socialPlatform: mission.definition.platform,
    isClaimSupported: !isClaimed,
    verification: 'USER_CONFIRMED',
    destinationUrl: mission.destinationUrl,
    ...(mission.accountHandle ? { accountHandle: mission.accountHandle } : {}),
    claimedAt: claim?.claimedAt?.toISOString() ?? null,
  };
}

/**
 * A watch tile.
 *
 * `progress` is always present and always server-computed. `resetsAt` is
 * always present too, because "this resets" is the single most important
 * thing a user needs to know about a daily mission, and inferring it from a
 * device timezone is exactly what this domain refuses to do.
 */
function toWatchTask(
  mission: WatchMissionDefinition,
  claim: RewardMissionClaim | null,
  episodesStarted: number,
  resetsAt: Date,
): RewardTaskDto {
  const isClaimed = claim?.claimedAt != null;
  const isComplete = episodesStarted >= mission.requiredEpisodes;

  return {
    id: mission.id,
    type: 'WATCH_EPISODES',
    rewardPoints: mission.rewardPoints,
    status: isClaimed
      ? 'COMPLETED'
      : isComplete
        ? 'CLAIMABLE'
        : episodesStarted > 0
          ? 'IN_PROGRESS'
          : 'AVAILABLE',
    isClaimSupported: !isClaimed,
    verification: 'SERVER_OBSERVED',
    progress: {
      // Clamped for display only: a user who started nine episodes has met a
      // three-episode goal, and "9/3" reads like a bug.
      current: Math.min(episodesStarted, mission.requiredEpisodes),
      required: mission.requiredEpisodes,
    },
    claimedAt: claim?.claimedAt?.toISOString() ?? null,
    resetsAt: resetsAt.toISOString(),
  };
}

function toWalletDto(row: {
  balancePoints: number;
  lifetimeEarnedPoints: number;
  version: number;
  updatedAt: Date;
}): RewardWalletDto {
  return {
    balancePoints: row.balancePoints,
    lifetimeEarnedPoints: row.lifetimeEarnedPoints,
    isServerAuthoritative: true,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}
