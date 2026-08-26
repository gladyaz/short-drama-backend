import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AppErrorCode } from '../common/errors/app-error-code';
import {
  fixtureEmail,
  TEST_FIXTURE_NAMESPACE,
} from '../common/testing/fixture-namespace.helpers';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { PrismaService } from '../prisma/prisma.service';
import { previousPeriodKey, toPeriodKey } from './reward-period.util';
import { RewardsMissionsService } from './rewards-missions.service';
import { RewardsPerksService } from './rewards-perks.service';
import { RewardsService } from './rewards.service';
import { RewardsWalletService } from './rewards-wallet.service';
import { RewardsWatchService } from './rewards-watch.service';
import { CHECK_IN_REWARD_CURVE } from './rewards.constants';

const TEST_TIMEZONE = 'Asia/Jakarta';

/**
 * Integration-style spec for the product layer, against the real test
 * database (the `EntitlementsService` precedent).
 *
 * HOW "ANOTHER DAY" IS SIMULATED WITHOUT FAKING THE CLOCK. The service reads
 * the real clock and derives the reward date from it, which is precisely the
 * property under test — mocking `Date` would test the mock. Instead each
 * streak scenario SEEDS the stored `RewardCheckIn` row into the state a user
 * would have arrived with (a `lastCheckInDate` of yesterday, of a week ago,
 * a streak of six) and then performs one REAL check-in today. Every
 * transition is therefore exercised against real dates, real timezone
 * arithmetic and a real database.
 *
 * A consequence worth naming: a user can only be paid once per real day, so
 * each scenario uses its own fresh user rather than chaining several
 * check-ins onto one.
 */
describe('RewardsService', () => {
  let service: RewardsService;
  let wallet: RewardsWalletService;
  let prisma: PrismaService;
  let userId: string;

  const today = (): string => toPeriodKey(new Date(), TEST_TIMEZONE);

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RewardsService,
        RewardsWalletService,
        RewardsMissionsService,
        RewardsPerksService,
        RewardsWatchService,
        EntitlementsService,
        PrismaService,
        {
          provide: ConfigService,
          useValue: {
            // Work unit "REWARDS V1 EARN AND SPEND": the mock now answers on
            // the `content` key too, because `buildRedemptions`/`redeem` read
            // the content-access mode to decide whether a VIP offer means
            // anything. Held at `entitlement` here so this file keeps testing
            // the premium redemption path it was written for; the free-mode
            // suppression has its own describe block below.
            get: (key: string) =>
              key === 'content'
                ? { accessMode: 'entitlement' }
                : { enabled: true, timezone: TEST_TIMEZONE },
          },
        },
      ],
    }).compile();

    service = module.get(RewardsService);
    wallet = module.get(RewardsWalletService);
    prisma = module.get(PrismaService);
    await prisma.onModuleInit();

    const user = await prisma.user.create({
      data: {
        email: fixtureEmail('rewards-service'),
        passwordHash: 'irrelevant-for-this-spec',
      },
    });
    userId = user.id;
  });

  afterEach(async () => {
    await prisma.user.deleteMany({
      where: { email: { contains: TEST_FIXTURE_NAMESPACE } },
    });
    await prisma.onModuleDestroy();
  });

  /** Seeds the streak row as if the user last checked in on `date`. */
  const seedStreak = (
    date: string,
    currentStreakDays: number,
    longestStreakDays = currentStreakDays,
  ) =>
    prisma.rewardCheckIn.create({
      data: {
        userId,
        currentStreakDays,
        longestStreakDays,
        totalCheckInDays: currentStreakDays,
        lastCheckInDate: date,
        lastCheckInAt: new Date(),
      },
    });

  const giveBalance = (points: number) =>
    service.devGrantPoints(userId, points, `seed-${points}`);

  describe('checkIn', () => {
    it('pays day 1 for a first-ever check-in and starts the streak', async () => {
      const result = await service.checkIn(userId);

      expect(result.alreadyCheckedIn).toBe(false);
      expect(result.awardedPoints).toBe(CHECK_IN_REWARD_CURVE[0]);
      expect(result.wallet.balancePoints).toBe(CHECK_IN_REWARD_CURVE[0]);
      expect(result.dailyCheckIn.currentStreakDays).toBe(1);
      expect(result.dailyCheckIn.isTodayClaimed).toBe(true);
      // The flag the mobile fixture set hardcoded false — real state now.
      expect(result.wallet.isServerAuthoritative).toBe(true);
    });

    it('CRITICAL: a second check-in on the same day pays nothing and is not an error', async () => {
      const first = await service.checkIn(userId);
      const second = await service.checkIn(userId);

      expect(second.alreadyCheckedIn).toBe(true);
      expect(second.awardedPoints).toBe(0);
      expect(second.wallet.balancePoints).toBe(first.wallet.balancePoints);
      expect(second.dailyCheckIn.currentStreakDays).toBe(1);
      expect(await prisma.rewardLedgerEntry.count({ where: { userId } })).toBe(
        1,
      );
    });

    it('CRITICAL: concurrent double-taps pay exactly once', async () => {
      const [a, b] = await Promise.all([
        service.checkIn(userId),
        service.checkIn(userId),
      ]);

      expect([a, b].filter((r) => r.alreadyCheckedIn)).toHaveLength(1);
      expect(await prisma.rewardLedgerEntry.count({ where: { userId } })).toBe(
        1,
      );
      expect((await wallet.readWallet(userId)).balancePoints).toBe(
        CHECK_IN_REWARD_CURVE[0],
      );
    });

    it('continues a streak checked in yesterday, paying the next day of the curve', async () => {
      await seedStreak(previousPeriodKey(today()), 3);

      const result = await service.checkIn(userId);

      expect(result.dailyCheckIn.currentStreakDays).toBe(4);
      expect(result.awardedPoints).toBe(CHECK_IN_REWARD_CURVE[3]);
    });

    it('pays the bonus day at the end of a full cycle', async () => {
      await seedStreak(previousPeriodKey(today()), 6);

      const result = await service.checkIn(userId);

      expect(result.dailyCheckIn.currentStreakDays).toBe(7);
      expect(result.awardedPoints).toBe(CHECK_IN_REWARD_CURVE[6]);
      expect(result.dailyCheckIn.days[6].isBonus).toBe(true);
    });

    it('wraps to day 1 of the curve after completing a cycle, without resetting the streak', async () => {
      await seedStreak(previousPeriodKey(today()), 7);

      const result = await service.checkIn(userId);

      // The reward curve repeats; the streak counter does not.
      expect(result.awardedPoints).toBe(CHECK_IN_REWARD_CURVE[0]);
      expect(result.dailyCheckIn.currentStreakDays).toBe(8);
    });

    it('CRITICAL: a missed day resets the streak to 1 and pays day 1', async () => {
      // Two days ago — a gap. The contract forbids silently repairing it.
      const twoDaysAgo = previousPeriodKey(previousPeriodKey(today()));
      await seedStreak(twoDaysAgo, 6);

      const result = await service.checkIn(userId);

      expect(result.dailyCheckIn.currentStreakDays).toBe(1);
      expect(result.awardedPoints).toBe(CHECK_IN_REWARD_CURVE[0]);
    });

    it('preserves longestStreakDays when the current streak resets', async () => {
      const twoDaysAgo = previousPeriodKey(previousPeriodKey(today()));
      await seedStreak(twoDaysAgo, 6, 11);

      const result = await service.checkIn(userId);

      expect(result.dailyCheckIn.currentStreakDays).toBe(1);
      expect(result.dailyCheckIn.longestStreakDays).toBe(11);
    });

    it('raises longestStreakDays when the current streak overtakes it', async () => {
      await seedStreak(previousPeriodKey(today()), 4, 4);

      const result = await service.checkIn(userId);

      expect(result.dailyCheckIn.longestStreakDays).toBe(5);
    });

    it('records the period key and streak day on the ledger entry, for audit', async () => {
      await service.checkIn(userId);

      const entry = await prisma.rewardLedgerEntry.findFirstOrThrow({
        where: { userId },
      });
      expect(entry.reason).toBe('DAILY_CHECK_IN');
      expect(entry.idempotencyKey).toBe(`DAILY_CHECK_IN:${today()}`);
      expect(entry.metadata).toMatchObject({ periodKey: today() });
    });

    it('leaves the ledger and the projection reconciled', async () => {
      await service.checkIn(userId);
      expect(await service.reconcile(userId)).toMatchObject({
        isConsistent: true,
      });
    });
  });

  describe('getSnapshot', () => {
    it('reports a zero, server-authoritative wallet for a fresh account', async () => {
      const snapshot = await service.getSnapshot(userId);

      expect(snapshot.wallet).toMatchObject({
        balancePoints: 0,
        lifetimeEarnedPoints: 0,
        isServerAuthoritative: true,
      });
      expect(snapshot.dailyCheckIn.isTodayClaimed).toBe(false);
      expect(snapshot.dailyCheckIn.isClaimSupported).toBe(true);
    });

    it('marks today as TODAY before the claim and CLAIMED after it', async () => {
      const before = await service.getSnapshot(userId);
      expect(before.dailyCheckIn.days[0].state).toBe('TODAY');

      await service.checkIn(userId);

      const after = await service.getSnapshot(userId);
      expect(after.dailyCheckIn.days[0].state).toBe('CLAIMED');
      // No day is TODAY once today has been claimed: day 2 is TOMORROW, and
      // marking it TODAY would invite a client to render it as actionable
      // and let a user tap into a request the server will only replay.
      expect(after.dailyCheckIn.days[1].state).toBe('UPCOMING');
      expect(after.dailyCheckIn.days.some((day) => day.state === 'TODAY')).toBe(
        false,
      );
    });

    it('renders prior days of a live streak as CLAIMED', async () => {
      await seedStreak(previousPeriodKey(today()), 3);

      const snapshot = await service.getSnapshot(userId);
      const states = snapshot.dailyCheckIn.days.map((day) => day.state);

      // Streak of 3, today unclaimed -> day 4 is the pending one.
      expect(states).toEqual([
        'CLAIMED',
        'CLAIMED',
        'CLAIMED',
        'TODAY',
        'UPCOMING',
        'UPCOMING',
        'UPCOMING',
      ]);
    });

    it('reports the server timezone and the next boundary, so the client never guesses', async () => {
      const snapshot = await service.getSnapshot(userId);

      expect(snapshot.dailyCheckIn.timezone).toBe(TEST_TIMEZONE);
      expect(snapshot.dailyCheckIn.periodKey).toBe(today());
      expect(
        new Date(snapshot.dailyCheckIn.resetsAt).getTime(),
      ).toBeGreaterThan(Date.now());
    });

    it('CRITICAL: reports watchTime as null rather than inventing a figure', async () => {
      // Still null, and still for the original reason: there is no measure of
      // watch DURATION here. Work unit "REWARDS V1 EARN AND SPEND" added
      // `WATCH_EPISODES` missions, which count episodes STARTED from
      // server-observed playback authorisations — a different, provable
      // quantity that is deliberately not reported through this field.
      const snapshot = await service.getSnapshot(userId);
      expect(snapshot.watchTime).toBeNull();
    });

    it('CRITICAL: every claimable task states how strong its evidence is', async () => {
      const snapshot = await service.getSnapshot(userId);

      expect(snapshot.tasks.length).toBeGreaterThan(0);

      for (const task of snapshot.tasks) {
        if (task.isClaimSupported) {
          // A claimable task must SAY what the server actually observed.
          // Without this the surface could pay for a social confirmation and
          // present it exactly like a server-verified one.
          expect(['USER_CONFIRMED', 'SERVER_OBSERVED']).toContain(
            task.verification,
          );
        } else {
          // An unclaimable one must say why, so the client renders an
          // explanation rather than a dead button.
          expect(task.unsupportedReason).toBeDefined();
        }
      }
    });

    it('CRITICAL: still refuses to pay a rewarded ad, which has no server callback', async () => {
      const snapshot = await service.getSnapshot(userId);
      const rewardedAd = snapshot.tasks.find(
        (task) => task.type === 'REWARDED_AD',
      );

      expect(rewardedAd?.isClaimSupported).toBe(false);
      expect(rewardedAd?.unsupportedReason).toBe('NO_VERIFIABLE_SIGNAL');
    });

    it('reports the caller active perks alongside everything else', async () => {
      const snapshot = await service.getSnapshot(userId);

      expect(snapshot.activePerks).toEqual({
        perks: [],
        skipNextInterstitial: false,
        adFreeUntil: null,
      });
    });

    it('computes redemption availability from the authoritative balance', async () => {
      const poor = await service.getSnapshot(userId);
      expect(
        poor.redemptions.find((offer) => offer.id === 'redeem_vip_1d')
          ?.availability,
      ).toBe('INSUFFICIENT_POINTS');

      await giveBalance(1200);

      const rich = await service.getSnapshot(userId);
      expect(
        rich.redemptions.find((offer) => offer.id === 'redeem_vip_1d')
          ?.availability,
      ).toBe('AVAILABLE');
    });

    it('marks a disabled offer COMING_SOON however large the balance', async () => {
      await giveBalance(90_000);

      const snapshot = await service.getSnapshot(userId);
      const offer = snapshot.redemptions.find(
        (entry) => entry.id === 'redeem_vip_7d',
      );
      expect(offer?.availability).toBe('COMING_SOON');
      expect(offer?.isRedeemSupported).toBe(false);
    });

    it('creates no rows — it is a pure read', async () => {
      await service.getSnapshot(userId);

      expect(await prisma.rewardWallet.count({ where: { userId } })).toBe(0);
      expect(await prisma.rewardCheckIn.count({ where: { userId } })).toBe(0);
    });
  });

  describe('redeem', () => {
    it('CRITICAL: debits the points AND grants the entitlement, atomically', async () => {
      await giveBalance(1500);

      const result = await service.redeem(
        userId,
        'redeem_vip_1d',
        'redeem-key-1',
      );

      expect(result.status).toBe('FULFILLED');
      expect(result.costPoints).toBe(1000);
      expect(result.wallet.balancePoints).toBe(500);

      // The entitlement is real, and came from the shared entitlement writer.
      const entitlement = await prisma.entitlement.findFirstOrThrow({
        where: { userId },
      });
      expect(entitlement.source).toBe('reward-redemption');
      expect(entitlement.tier).toBe('premium');
      expect(result.entitlementExpiresAt).not.toBeNull();

      // And the receipt links the debit to the grant.
      const redemption = await prisma.rewardRedemption.findFirstOrThrow({
        where: { userId },
      });
      expect(redemption.entitlementId).toBe(entitlement.id);
      expect(redemption.ledgerEntryId).not.toBeNull();
    });

    it('makes the user premium through the existing entitlement system', async () => {
      await giveBalance(1000);
      await service.redeem(userId, 'redeem_vip_1d', 'redeem-key-2');

      const entitlements = new EntitlementsService(prisma);
      expect(await entitlements.isEntitled(userId)).toBe(true);
    });

    it('CRITICAL: refuses a redemption the balance cannot cover, changing nothing', async () => {
      await giveBalance(999);

      await expect(
        service.redeem(userId, 'redeem_vip_1d', 'redeem-key-3'),
      ).rejects.toMatchObject({
        code: AppErrorCode.INSUFFICIENT_REWARD_POINTS,
      });

      expect((await wallet.readWallet(userId)).balancePoints).toBe(999);
      // No entitlement was granted for a redemption that did not happen.
      expect(await prisma.entitlement.count({ where: { userId } })).toBe(0);
      expect(await prisma.rewardRedemption.count({ where: { userId } })).toBe(
        0,
      );
    });

    it('CRITICAL: replaying the same idempotency key returns the original receipt and charges once', async () => {
      await giveBalance(3000);

      const first = await service.redeem(userId, 'redeem_vip_1d', 'replay-key');
      const second = await service.redeem(
        userId,
        'redeem_vip_1d',
        'replay-key',
      );

      expect(second.replayed).toBe(true);
      expect(second.redemptionId).toBe(first.redemptionId);
      expect((await wallet.readWallet(userId)).balancePoints).toBe(2000);
      expect(await prisma.entitlement.count({ where: { userId } })).toBe(1);
    });

    it('CRITICAL: refuses a key reused for a DIFFERENT offer instead of replaying the wrong receipt', async () => {
      await giveBalance(5000);
      await service.redeem(userId, 'redeem_vip_1d', 'shared-key');

      await expect(
        service.redeem(userId, 'redeem_vip_3d', 'shared-key'),
      ).rejects.toMatchObject({
        code: AppErrorCode.REWARD_IDEMPOTENCY_KEY_REUSED,
      });
    });

    it('allows two genuine redemptions under different keys, stacking the entitlement', async () => {
      await giveBalance(3000);

      const first = await service.redeem(userId, 'redeem_vip_1d', 'buy-1');
      const second = await service.redeem(userId, 'redeem_vip_1d', 'buy-2');

      expect((await wallet.readWallet(userId)).balancePoints).toBe(1000);
      expect(await prisma.entitlement.count({ where: { userId } })).toBe(2);
      // Second grant extends beyond the first rather than overwriting it.
      expect(new Date(second.entitlementExpiresAt!).getTime()).toBeGreaterThan(
        new Date(first.entitlementExpiresAt!).getTime(),
      );
    });

    it('refuses an offer that is not in the catalog', async () => {
      await giveBalance(5000);
      await expect(
        service.redeem(userId, 'redeem_nonexistent', 'unknown-key'),
      ).rejects.toMatchObject({ code: AppErrorCode.REWARD_OFFER_NOT_FOUND });
    });

    it('CRITICAL: refuses a disabled offer server-side, not just in the UI', async () => {
      await giveBalance(90_000);
      await expect(
        service.redeem(userId, 'redeem_vip_7d', 'disabled-key'),
      ).rejects.toMatchObject({ code: AppErrorCode.REWARD_OFFER_UNAVAILABLE });
    });

    it('leaves ledger and projection reconciled after a redemption', async () => {
      await giveBalance(2000);
      await service.redeem(userId, 'redeem_vip_1d', 'reconcile-key');

      expect(await service.reconcile(userId)).toMatchObject({
        isConsistent: true,
        walletBalancePoints: 1000,
        // Lifetime earned counts credits only — a purchase does not reduce it.
        walletLifetimeEarnedPoints: 2000,
      });
    });
  });

  describe('getLedger', () => {
    it('returns entries newest-first', async () => {
      await giveBalance(10);
      await giveBalance(20);
      await giveBalance(30);

      const page = await service.getLedger(userId, undefined, undefined);
      expect(page.entries.map((entry) => entry.deltaPoints)).toEqual([
        30, 20, 10,
      ]);
      expect(page.nextCursor).toBeNull();
    });

    it('pages with a cursor, without repeating or skipping an entry', async () => {
      for (let i = 1; i <= 5; i += 1) {
        await giveBalance(i * 10);
      }

      const first = await service.getLedger(userId, 2, undefined);
      expect(first.entries).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();

      const second = await service.getLedger(userId, 2, first.nextCursor!);
      const third = await service.getLedger(userId, 2, second.nextCursor!);

      const seen = [...first.entries, ...second.entries, ...third.entries];
      expect(seen).toHaveLength(5);
      expect(new Set(seen.map((entry) => entry.id)).size).toBe(5);
      expect(third.nextCursor).toBeNull();
    });

    it('shows a redemption as a negative entry alongside its credits', async () => {
      await giveBalance(1500);
      await service.redeem(userId, 'redeem_vip_1d', 'ledger-key');

      const page = await service.getLedger(userId, undefined, undefined);
      expect(page.entries[0]).toMatchObject({
        deltaPoints: -1000,
        reason: 'VIP_REDEMPTION',
        balanceAfter: 500,
      });
    });

    it("never returns another user's entries", async () => {
      const other = await prisma.user.create({
        data: {
          email: fixtureEmail('rewards-service-other'),
          passwordHash: 'irrelevant',
        },
      });
      await giveBalance(100);

      const page = await service.getLedger(other.id, undefined, undefined);
      expect(page.entries).toHaveLength(0);
    });
  });

  describe('devGrantPoints', () => {
    it('credits through the ledger, not by writing a balance', async () => {
      const result = await service.devGrantPoints(userId, 500, 'dev-key');

      expect(result.balancePoints).toBe(500);
      const entry = await prisma.rewardLedgerEntry.findFirstOrThrow({
        where: { userId },
      });
      expect(entry.reason).toBe('ADJUSTMENT');
      expect(entry.sourceType).toBe('DEV_TOOL');
      expect(await service.reconcile(userId)).toMatchObject({
        isConsistent: true,
      });
    });

    it('is idempotent, so a double-tapped demo button grants once', async () => {
      await service.devGrantPoints(userId, 500, 'dev-key');
      const second = await service.devGrantPoints(userId, 500, 'dev-key');

      expect(second.balancePoints).toBe(500);
    });

    it('refuses a non-positive or oversized grant', async () => {
      await expect(
        service.devGrantPoints(userId, 0, 'bad-1'),
      ).rejects.toMatchObject({
        code: AppErrorCode.REWARD_LEDGER_INVALID_DELTA,
      });
      await expect(
        service.devGrantPoints(userId, 10_000_000, 'bad-2'),
      ).rejects.toMatchObject({
        code: AppErrorCode.REWARD_LEDGER_INVALID_DELTA,
      });
    });
  });
});

/**
 * Work unit "REWARDS V1 EARN AND SPEND": the V1 posture — every episode free,
 * so a VIP offer sells nothing.
 *
 * A SEPARATE MODULE rather than a mutated mock, because the content-access
 * mode is read per call from `ConfigService` and building the second module
 * makes the two postures independently readable rather than order-dependent.
 */
describe('RewardsService under CONTENT_ACCESS_MODE=free', () => {
  let service: RewardsService;
  let prisma: PrismaService;
  let userId: string;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RewardsService,
        RewardsWalletService,
        RewardsMissionsService,
        RewardsPerksService,
        RewardsWatchService,
        EntitlementsService,
        PrismaService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'content'
                ? { accessMode: 'free' }
                : { enabled: true, timezone: TEST_TIMEZONE },
          },
        },
      ],
    }).compile();

    service = module.get(RewardsService);
    prisma = module.get(PrismaService);
    await prisma.onModuleInit();

    const user = await prisma.user.create({
      data: {
        email: fixtureEmail('rewards-free-mode'),
        passwordHash: 'irrelevant-for-this-spec',
      },
    });
    userId = user.id;
  });

  afterEach(async () => {
    await prisma.user.deleteMany({
      where: { email: { contains: TEST_FIXTURE_NAMESPACE } },
    });
    await prisma.onModuleDestroy();
  });

  it('CRITICAL: withholds every premium offer, and says why', async () => {
    await service.devGrantPoints(userId, 90_000, 'free-mode-seed');

    const snapshot = await service.getSnapshot(userId);
    const premium = snapshot.redemptions.filter(
      (offer) => offer.kind === 'PREMIUM_DAYS',
    );

    expect(premium.length).toBeGreaterThan(0);
    for (const offer of premium) {
      // Not "you cannot afford it" — the balance is 90,000. The offer simply
      // does not mean anything in a deployment with nothing locked.
      expect(offer.availability).toBe('COMING_SOON');
      expect(offer.isRedeemSupported).toBe(false);
      expect(offer.unavailableReason).toBe('NOT_APPLICABLE_IN_FREE_MODE');
    }
  });

  it('CRITICAL: refuses a premium redemption server-side, and charges nothing', async () => {
    await service.devGrantPoints(userId, 90_000, 'free-mode-seed-2');

    // A client working from a stale catalog must not be able to buy it
    // either — the snapshot withholding it is not the control.
    await expect(
      service.redeem(userId, 'redeem_vip_1d', 'free-mode-key-01'),
    ).rejects.toMatchObject({
      code: AppErrorCode.REWARD_OFFER_UNAVAILABLE,
    });

    const wallet = await prisma.rewardWallet.findUniqueOrThrow({
      where: { userId },
    });
    expect(wallet.balancePoints).toBe(90_000);
    expect(await prisma.rewardRedemption.count({ where: { userId } })).toBe(0);
  });

  it('CRITICAL: still sells ad perks, so coins keep a use', async () => {
    await service.devGrantPoints(userId, 90_000, 'free-mode-seed-3');

    const snapshot = await service.getSnapshot(userId);
    const adPerks = snapshot.redemptions.filter(
      (offer) => offer.kind === 'AD_PERK',
    );

    expect(adPerks.length).toBeGreaterThan(0);
    for (const offer of adPerks) {
      expect(offer.availability).toBe('AVAILABLE');
      expect(offer.isRedeemSupported).toBe(true);
    }

    const receipt = await service.redeem(
      userId,
      'redeem_skip_next_ad',
      'free-mode-key-02',
    );
    expect(receipt.perk).not.toBeNull();
  });
});
