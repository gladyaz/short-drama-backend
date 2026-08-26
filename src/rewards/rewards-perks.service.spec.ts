import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AppErrorCode } from '../common/errors/app-error-code';
import {
  fixtureEmail,
  TEST_FIXTURE_NAMESPACE,
} from '../common/testing/fixture-namespace.helpers';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { PrismaService } from '../prisma/prisma.service';
import { RewardsMissionsService } from './rewards-missions.service';
import { RewardsPerksService } from './rewards-perks.service';
import { RewardsService } from './rewards.service';
import { RewardsWalletService } from './rewards-wallet.service';
import { RewardsWatchService } from './rewards-watch.service';
import {
  findRedemptionOffer,
  REWARD_PERK_STATUSES,
  REWARD_PERK_TYPES,
  REWARD_REASONS,
} from './rewards.constants';

const TEST_TIMEZONE = 'Asia/Jakarta';

const SKIP_OFFER_ID = 'redeem_skip_next_ad';
const PASS_OFFER_ID = 'redeem_ad_pass_2h';

/**
 * Work unit "REWARDS V1 EARN AND SPEND": the SPEND half of the V1 loop —
 * points become an ad perk, atomically, once.
 *
 * Runs against the real database, through the REAL redemption path
 * (`RewardsService.redeem`) rather than by inserting perks directly: the
 * property under test is that a debit and an issuance happen together, and a
 * spec that hand-created the perk would test neither half of that.
 *
 * `CONTENT_ACCESS_MODE` is held at its default (`entitlement`) by the config
 * mock, so both offer kinds are purchasable here. The free-mode suppression
 * of the VIP offers is covered separately.
 */
describe('RewardsPerksService', () => {
  let perks: RewardsPerksService;
  let rewards: RewardsService;
  let prisma: PrismaService;
  let userId: string;

  const skipOffer = findRedemptionOffer(SKIP_OFFER_ID)!;
  const passOffer = findRedemptionOffer(PASS_OFFER_ID)!;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RewardsService,
        RewardsPerksService,
        RewardsMissionsService,
        RewardsWatchService,
        RewardsWalletService,
        EntitlementsService,
        PrismaService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'content'
                ? { accessMode: 'entitlement' }
                : { enabled: true, timezone: TEST_TIMEZONE },
          },
        },
      ],
    }).compile();

    perks = module.get(RewardsPerksService);
    rewards = module.get(RewardsService);
    prisma = module.get(PrismaService);
    await prisma.onModuleInit();

    const user = await prisma.user.create({
      data: {
        email: fixtureEmail('rewards-perks'),
        passwordHash: 'irrelevant-for-this-spec',
      },
    });
    userId = user.id;
  });

  afterEach(async () => {
    await prisma.user.deleteMany({
      where: { email: { startsWith: TEST_FIXTURE_NAMESPACE } },
    });
    await prisma.onModuleDestroy();
  });

  const giveBalance = (points: number) =>
    rewards.devGrantPoints(userId, points, `perkseed-${points}`);

  const buySkip = (key = 'perk-key-skip-0001') =>
    rewards.redeem(userId, SKIP_OFFER_ID, key);

  describe('redeeming an ad perk', () => {
    it('CRITICAL: debits the exact cost and issues the perk in one call', async () => {
      await giveBalance(skipOffer.costPoints + 25);

      const receipt = await buySkip();

      expect(receipt.replayed).toBe(false);
      expect(receipt.costPoints).toBe(skipOffer.costPoints);
      expect(receipt.wallet.balancePoints).toBe(25);
      expect(receipt.perk).not.toBeNull();
      expect(receipt.perk!.perkType).toBe(
        REWARD_PERK_TYPES.SKIP_NEXT_INTERSTITIAL,
      );
      expect(receipt.perk!.remainingUses).toBe(1);
      // An ad perk buys no premium at all.
      expect(receipt.grantsDays).toBe(0);
      expect(receipt.entitlementExpiresAt).toBeNull();
    });

    it('books the debit under its own ledger reason, not VIP', async () => {
      await giveBalance(skipOffer.costPoints);
      await buySkip();

      const debit = await prisma.rewardLedgerEntry.findFirstOrThrow({
        where: { userId, deltaPoints: { lt: 0 } },
      });

      expect(debit.reason).toBe(REWARD_REASONS.AD_PERK_REDEMPTION);
      expect(debit.deltaPoints).toBe(-skipOffer.costPoints);
      expect(debit.sourceId).toBe(SKIP_OFFER_ID);
    });

    it('CRITICAL: refuses a purchase the balance cannot cover, and issues nothing', async () => {
      await giveBalance(skipOffer.costPoints - 1);

      await expect(buySkip()).rejects.toMatchObject({
        code: AppErrorCode.INSUFFICIENT_REWARD_POINTS,
      });

      // The whole point of the atomic branch: a failed debit leaves NO perk.
      expect(await prisma.rewardPerk.count({ where: { userId } })).toBe(0);
      expect(await prisma.rewardRedemption.count({ where: { userId } })).toBe(
        0,
      );

      const wallet = await prisma.rewardWallet.findUniqueOrThrow({
        where: { userId },
      });
      expect(wallet.balancePoints).toBe(skipOffer.costPoints - 1);
    });

    it('CRITICAL: replaying the same idempotency key charges once and issues one perk', async () => {
      await giveBalance(skipOffer.costPoints * 2);

      const first = await buySkip('perk-replay-key-01');
      const second = await buySkip('perk-replay-key-01');

      expect(second.replayed).toBe(true);
      expect(second.redemptionId).toBe(first.redemptionId);
      // The ORIGINAL perk, not a second one.
      expect(second.perk!.id).toBe(first.perk!.id);
      expect(second.wallet.balancePoints).toBe(first.wallet.balancePoints);
      expect(await prisma.rewardPerk.count({ where: { userId } })).toBe(1);
    });

    it('CRITICAL: two concurrent redemptions with one key charge once', async () => {
      await giveBalance(skipOffer.costPoints * 2);

      const results = await Promise.allSettled([
        buySkip('perk-race-key-0001'),
        buySkip('perk-race-key-0001'),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      // One may win outright and the other replay, or one may lose the unique
      // index — what must never happen is two charges or two perks.
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      expect(await prisma.rewardPerk.count({ where: { userId } })).toBe(1);

      const wallet = await prisma.rewardWallet.findUniqueOrThrow({
        where: { userId },
      });
      expect(wallet.balancePoints).toBe(skipOffer.costPoints);
    });

    it('allows two genuine purchases under different keys', async () => {
      await giveBalance(skipOffer.costPoints * 2);

      await buySkip('perk-genuine-key-01');
      await buySkip('perk-genuine-key-02');

      expect(await prisma.rewardPerk.count({ where: { userId } })).toBe(2);

      const active = await perks.getActivePerks(userId);
      expect(active.perks).toHaveLength(2);
      expect(active.skipNextInterstitial).toBe(true);
    });

    it('links the receipt to the perk it issued', async () => {
      await giveBalance(skipOffer.costPoints);
      const receipt = await buySkip();

      const redemption = await prisma.rewardRedemption.findUniqueOrThrow({
        where: { id: receipt.redemptionId },
      });

      expect(redemption.perkId).toBe(receipt.perk!.id);
      expect(redemption.entitlementId).toBeNull();
    });
  });

  describe('the ad gate view', () => {
    it('answers "no perks" for an account that holds none', async () => {
      const active = await perks.getActivePerks(userId);

      expect(active.perks).toEqual([]);
      expect(active.skipNextInterstitial).toBe(false);
      expect(active.adFreeUntil).toBeNull();
    });

    it('CRITICAL: reports a temporary pass as an ad-free window', async () => {
      await giveBalance(passOffer.costPoints);
      const receipt = await rewards.redeem(
        userId,
        PASS_OFFER_ID,
        'perk-pass-key-0001',
      );

      const active = await perks.getActivePerks(userId);

      expect(active.adFreeUntil).toBe(receipt.perk!.expiresAt);
      // A pass is not a skip: the two are separate answers to separate
      // questions, and conflating them would make one perk do the other's job.
      expect(active.skipNextInterstitial).toBe(false);
      expect(active.perks[0].remainingUses).toBeNull();
    });

    it('reports the furthest expiry when two passes overlap', async () => {
      await giveBalance(passOffer.costPoints * 2);

      const first = await rewards.redeem(userId, PASS_OFFER_ID, 'pass-key-a01');
      const second = await rewards.redeem(
        userId,
        PASS_OFFER_ID,
        'pass-key-b01',
      );

      const active = await perks.getActivePerks(userId);
      const furthest = [first, second]
        .map((r) => r.perk!.expiresAt)
        .sort()
        .at(-1);

      expect(active.adFreeUntil).toBe(furthest);
    });

    it('CRITICAL: an expired perk is not live, whatever its status column says', async () => {
      await giveBalance(skipOffer.costPoints);
      const receipt = await buySkip();

      // Wind the expiry into the past WITHOUT touching `status`, which stays
      // `ACTIVE`. Liveness is derived from the clock, so nothing needs to have
      // run for the perk to stop working.
      await prisma.rewardPerk.update({
        where: { id: receipt.perk!.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const active = await perks.getActivePerks(userId);

      expect(active.perks).toEqual([]);
      expect(active.skipNextInterstitial).toBe(false);

      const stored = await prisma.rewardPerk.findUniqueOrThrow({
        where: { id: receipt.perk!.id },
      });
      expect(stored.status).toBe(REWARD_PERK_STATUSES.ACTIVE);
    });

    it('markExpired tidies the status column without changing any decision', async () => {
      await giveBalance(skipOffer.costPoints);
      const receipt = await buySkip();

      await prisma.rewardPerk.update({
        where: { id: receipt.perk!.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      expect(await perks.markExpired(userId)).toBe(1);

      const stored = await prisma.rewardPerk.findUniqueOrThrow({
        where: { id: receipt.perk!.id },
      });
      expect(stored.status).toBe(REWARD_PERK_STATUSES.EXPIRED);
    });
  });

  describe('consuming a skip', () => {
    it('CRITICAL: spends the perk exactly once', async () => {
      await giveBalance(skipOffer.costPoints);
      const receipt = await buySkip();

      const outcome = await perks.consume(userId, receipt.perk!.id);

      expect(outcome).toEqual({ consumed: true, alreadyConsumed: false });

      const stored = await prisma.rewardPerk.findUniqueOrThrow({
        where: { id: receipt.perk!.id },
      });
      expect(stored.status).toBe(REWARD_PERK_STATUSES.CONSUMED);
      expect(stored.remainingUses).toBe(0);
      expect(stored.consumedAt).not.toBeNull();

      const active = await perks.getActivePerks(userId);
      expect(active.skipNextInterstitial).toBe(false);
    });

    it('CRITICAL: a second consume changes nothing and is not an error', async () => {
      await giveBalance(skipOffer.costPoints);
      const receipt = await buySkip();

      await perks.consume(userId, receipt.perk!.id);
      const second = await perks.consume(userId, receipt.perk!.id);

      expect(second).toEqual({ consumed: false, alreadyConsumed: true });
    });

    it('CRITICAL: two concurrent consumes spend the perk once', async () => {
      await giveBalance(skipOffer.costPoints);
      const receipt = await buySkip();

      const results = await Promise.all([
        perks.consume(userId, receipt.perk!.id),
        perks.consume(userId, receipt.perk!.id),
      ]);

      expect(results.filter((r) => r.consumed)).toHaveLength(1);
      expect(results.filter((r) => r.alreadyConsumed)).toHaveLength(1);

      const stored = await prisma.rewardPerk.findUniqueOrThrow({
        where: { id: receipt.perk!.id },
      });
      expect(stored.remainingUses).toBe(0);
    });

    it('CRITICAL: one account cannot consume another account perk', async () => {
      await giveBalance(skipOffer.costPoints);
      const receipt = await buySkip();

      const other = await prisma.user.create({
        data: {
          email: fixtureEmail('rewards-perks-other'),
          passwordHash: 'irrelevant-for-this-spec',
        },
      });

      // Ownership-scoped 404: indistinguishable from an id that does not
      // exist, so this cannot be used to probe another account.
      await expect(
        perks.consume(other.id, receipt.perk!.id),
      ).rejects.toMatchObject({ code: AppErrorCode.REWARD_PERK_NOT_FOUND });

      const stored = await prisma.rewardPerk.findUniqueOrThrow({
        where: { id: receipt.perk!.id },
      });
      expect(stored.status).toBe(REWARD_PERK_STATUSES.ACTIVE);
    });

    it('refuses to consume a time-based pass', async () => {
      await giveBalance(passOffer.costPoints);
      const receipt = await rewards.redeem(
        userId,
        PASS_OFFER_ID,
        'perk-pass-key-0002',
      );

      await expect(
        perks.consume(userId, receipt.perk!.id),
      ).rejects.toMatchObject({
        code: AppErrorCode.REWARD_PERK_NOT_CONSUMABLE,
      });
    });

    it('refuses to consume an expired skip', async () => {
      await giveBalance(skipOffer.costPoints);
      const receipt = await buySkip();

      await prisma.rewardPerk.update({
        where: { id: receipt.perk!.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await expect(
        perks.consume(userId, receipt.perk!.id),
      ).rejects.toMatchObject({ code: AppErrorCode.REWARD_PERK_EXPIRED });
    });

    it('refuses an unknown perk id', async () => {
      await expect(
        perks.consume(userId, 'not-a-real-perk-id'),
      ).rejects.toMatchObject({ code: AppErrorCode.REWARD_PERK_NOT_FOUND });
    });
  });
});
