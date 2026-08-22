import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import {
  fixtureEmail,
  TEST_FIXTURE_NAMESPACE,
} from '../common/testing/fixture-namespace.helpers';
import { RewardsWalletService } from './rewards-wallet.service';
import { REWARD_REASONS, REWARD_SOURCE_TYPES } from './rewards.constants';

/**
 * Integration-style spec against the real Postgres test database, following
 * the `EntitlementsService` / `InteractionsService` precedent (real
 * `PrismaService`, self-cleaning `afterEach`).
 *
 * IT HAS TO BE A REAL DATABASE. Every property this class claims is a
 * DATABASE property: a unique constraint admitting exactly one of two
 * concurrent inserts, a `SELECT ... FOR UPDATE` serialising two
 * transactions, a CHECK constraint refusing a negative balance, and an
 * all-or-nothing commit. A mocked Prisma client would happily "pass" all of
 * them while the real system double-paid — the mock would be asserting that
 * the test's own stub behaves, not that Postgres does.
 */
describe('RewardsWalletService', () => {
  let service: RewardsWalletService;
  let prisma: PrismaService;
  let userId: string;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RewardsWalletService, PrismaService],
    }).compile();

    service = module.get(RewardsWalletService);
    prisma = module.get(PrismaService);
    await prisma.onModuleInit();

    const user = await prisma.user.create({
      data: {
        email: fixtureEmail('rewards-wallet'),
        passwordHash: 'irrelevant-for-this-spec',
      },
    });
    userId = user.id;
  });

  afterEach(async () => {
    // Reward rows cascade with the User, so deleting the user is sufficient
    // and also proves the cascade works.
    await prisma.user.deleteMany({
      where: { email: { contains: TEST_FIXTURE_NAMESPACE } },
    });
    await prisma.onModuleDestroy();
  });

  const credit = (points: number, key: string) =>
    prisma.$transaction((tx) =>
      service.appendEntry(tx, {
        userId,
        deltaPoints: points,
        reason: REWARD_REASONS.ADJUSTMENT,
        sourceType: REWARD_SOURCE_TYPES.DEV_TOOL,
        idempotencyKey: key,
      }),
    );

  describe('readWallet', () => {
    it('reports a zero wallet for a user who has never earned, WITHOUT creating a row', () => {
      return service.readWallet(userId).then(async (view) => {
        expect(view.balancePoints).toBe(0);
        expect(view.lifetimeEarnedPoints).toBe(0);
        expect(view.updatedAt).toBeNull();

        // A read endpoint that writes would turn every poll of the Rewards
        // screen into a database insert.
        const rows = await prisma.rewardWallet.count({ where: { userId } });
        expect(rows).toBe(0);
      });
    });
  });

  describe('appendEntry', () => {
    it('creates the wallet on first movement and moves the balance', async () => {
      const result = await credit(100, 'first-credit');

      expect(result.replayed).toBe(false);
      expect(result.entry.deltaPoints).toBe(100);
      expect(result.entry.balanceAfter).toBe(100);
      expect(result.wallet.balancePoints).toBe(100);
      expect(result.wallet.lifetimeEarnedPoints).toBe(100);
      expect(result.wallet.version).toBe(1);
    });

    it('snapshots balanceAfter on every entry, so a statement renders without a running sum', async () => {
      await credit(100, 'k1');
      await credit(50, 'k2');
      const third = await credit(25, 'k3');

      expect(third.entry.balanceAfter).toBe(175);
      const entries = await prisma.rewardLedgerEntry.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      });
      expect(entries.map((e) => e.balanceAfter)).toEqual([100, 150, 175]);
    });

    it('CRITICAL: a replayed idempotency key pays nothing and writes no second row', async () => {
      const first = await credit(100, 'same-key');
      const second = await credit(100, 'same-key');

      expect(second.replayed).toBe(true);
      // The ORIGINAL entry is returned, not a new one.
      expect(second.entry.id).toBe(first.entry.id);
      expect(second.wallet.balancePoints).toBe(100);

      const count = await prisma.rewardLedgerEntry.count({ where: { userId } });
      expect(count).toBe(1);
    });

    it('CRITICAL: a replay does not MUTATE the original entry either — the ledger is append-only', async () => {
      const first = await credit(100, 'immutable-key');
      const before = await prisma.rewardLedgerEntry.findUniqueOrThrow({
        where: { id: first.entry.id },
      });

      await credit(100, 'immutable-key');

      const after = await prisma.rewardLedgerEntry.findUniqueOrThrow({
        where: { id: first.entry.id },
      });
      expect(after).toEqual(before);
    });

    it('CRITICAL: two CONCURRENT identical claims produce exactly one payment', async () => {
      // The money test. Both transactions race for the same idempotency key;
      // the `SELECT ... FOR UPDATE` on the User row admits one at a time, and
      // the second finds the committed row and replays. Without the lock this
      // is the classic check-then-insert double-pay.
      const [a, b] = await Promise.all([
        credit(100, 'concurrent-key'),
        credit(100, 'concurrent-key'),
      ]);

      const replays = [a, b].filter((r) => r.replayed);
      expect(replays).toHaveLength(1);

      const count = await prisma.rewardLedgerEntry.count({ where: { userId } });
      expect(count).toBe(1);

      const wallet = await service.readWallet(userId);
      expect(wallet.balancePoints).toBe(100);
    });

    it('CRITICAL: many concurrent identical claims still produce exactly one payment', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => credit(250, 'stampede-key')),
      );

      expect(results.filter((r) => r.replayed)).toHaveLength(4);
      expect(await prisma.rewardLedgerEntry.count({ where: { userId } })).toBe(
        1,
      );
      expect((await service.readWallet(userId)).balancePoints).toBe(250);
    });

    it('applies concurrent DISTINCT movements without losing any of them', async () => {
      // Serialisation must not silently drop writes: five different keys are
      // five real movements, and a lost-update bug would show up as a total
      // below 150.
      await Promise.all([
        credit(10, 'd1'),
        credit(20, 'd2'),
        credit(30, 'd3'),
        credit(40, 'd4'),
        credit(50, 'd5'),
      ]);

      const wallet = await service.readWallet(userId);
      expect(wallet.balancePoints).toBe(150);
      expect(wallet.version).toBe(5);
      expect(await service.reconcile(userId)).toMatchObject({
        isConsistent: true,
      });
    });

    it('debits reduce the balance but never the lifetime-earned total', async () => {
      await credit(100, 'earn');
      const debit = await prisma.$transaction((tx) =>
        service.appendEntry(tx, {
          userId,
          deltaPoints: -40,
          reason: REWARD_REASONS.VIP_REDEMPTION,
          sourceType: REWARD_SOURCE_TYPES.REDEMPTION,
          idempotencyKey: 'spend',
        }),
      );

      expect(debit.wallet.balancePoints).toBe(60);
      // "Points you have ever earned" must be a number that only goes up, or
      // it is not what it says it is.
      expect(debit.wallet.lifetimeEarnedPoints).toBe(100);
    });

    it('CRITICAL: refuses a debit that would overdraw, and leaves the balance untouched', async () => {
      await credit(50, 'small-balance');

      await expect(
        prisma.$transaction((tx) =>
          service.appendEntry(tx, {
            userId,
            deltaPoints: -51,
            reason: REWARD_REASONS.VIP_REDEMPTION,
            sourceType: REWARD_SOURCE_TYPES.REDEMPTION,
            idempotencyKey: 'overdraw',
          }),
        ),
      ).rejects.toMatchObject({
        code: AppErrorCode.INSUFFICIENT_REWARD_POINTS,
      });

      expect((await service.readWallet(userId)).balancePoints).toBe(50);
      expect(
        await prisma.rewardLedgerEntry.count({
          where: { userId, idempotencyKey: 'overdraw' },
        }),
      ).toBe(0);
    });

    it('permits a debit that lands exactly on zero', async () => {
      await credit(50, 'exact');
      const result = await prisma.$transaction((tx) =>
        service.appendEntry(tx, {
          userId,
          deltaPoints: -50,
          reason: REWARD_REASONS.VIP_REDEMPTION,
          sourceType: REWARD_SOURCE_TYPES.REDEMPTION,
          idempotencyKey: 'to-zero',
        }),
      );

      expect(result.wallet.balancePoints).toBe(0);
    });

    it('refuses a zero delta as a server-side bug, not a client error', async () => {
      await expect(credit(0, 'zero')).rejects.toBeInstanceOf(AppException);
    });

    it('refuses a movement for a user that does not exist', async () => {
      await expect(
        prisma.$transaction((tx) =>
          service.appendEntry(tx, {
            userId: 'user-that-does-not-exist',
            deltaPoints: 10,
            reason: REWARD_REASONS.ADJUSTMENT,
            sourceType: REWARD_SOURCE_TYPES.DEV_TOOL,
            idempotencyKey: 'ghost',
          }),
        ),
      ).rejects.toMatchObject({ code: AppErrorCode.USER_NOT_FOUND });
    });

    it('CRITICAL: rolls the ledger append back when the surrounding transaction fails', async () => {
      // Proves atomicity from the caller's side: `redeem` relies on the debit
      // vanishing if the entitlement grant throws.
      await expect(
        prisma.$transaction(async (tx) => {
          await service.appendEntry(tx, {
            userId,
            deltaPoints: 500,
            reason: REWARD_REASONS.ADJUSTMENT,
            sourceType: REWARD_SOURCE_TYPES.DEV_TOOL,
            idempotencyKey: 'rolled-back',
          });
          throw new Error('caller failed after the append');
        }),
      ).rejects.toThrow('caller failed after the append');

      expect(await prisma.rewardLedgerEntry.count({ where: { userId } })).toBe(
        0,
      );
      expect((await service.readWallet(userId)).balancePoints).toBe(0);
    });

    it('isolates wallets between users', async () => {
      const other = await prisma.user.create({
        data: {
          email: fixtureEmail('rewards-wallet-other'),
          passwordHash: 'irrelevant',
        },
      });

      await credit(100, 'mine');
      // Same idempotency key, different user: the constraint is scoped to
      // (userId, idempotencyKey), so this must be a real second payment.
      await prisma.$transaction((tx) =>
        service.appendEntry(tx, {
          userId: other.id,
          deltaPoints: 7,
          reason: REWARD_REASONS.ADJUSTMENT,
          sourceType: REWARD_SOURCE_TYPES.DEV_TOOL,
          idempotencyKey: 'mine',
        }),
      );

      expect((await service.readWallet(userId)).balancePoints).toBe(100);
      expect((await service.readWallet(other.id)).balancePoints).toBe(7);
    });
  });

  /**
   * POSITIVE CONTROL, mirroring the discipline `auth-lock-order.spec.ts`
   * established for the auth lock order: without it, the concurrency tests
   * above could pass for the wrong reason. A harness that cannot actually
   * force two transactions to interleave would report green forever, and so
   * would a build in which the lock had been quietly removed but the race
   * never materialised on the tester's machine.
   *
   * This test replays the NAIVE, UNLOCKED check-then-insert at the raw
   * Prisma level and asserts the failure it produces. It exercises no
   * `RewardsWalletService` code path — nothing in this codebase performs the
   * unlocked sequence, and nothing may reintroduce it.
   */
  describe('lock necessity (positive control)', () => {
    it('CRITICAL: an UNLOCKED check-then-insert loses one caller to a constraint violation', async () => {
      const wallet = await prisma.rewardWallet.create({ data: { userId } });

      const unlockedAttempt = () =>
        prisma.$transaction(async (tx) => {
          // Deliberately NO `lockAccount` call — this is the pre-lock shape.
          const existing = await tx.rewardLedgerEntry.findUnique({
            where: {
              userId_idempotencyKey: { userId, idempotencyKey: 'race-probe' },
            },
          });
          if (existing) {
            return 'replayed';
          }
          // Widen the window so the interleaving is deterministic rather than
          // dependent on how fast the database answers.
          await new Promise((resolve) => setTimeout(resolve, 30));
          await tx.rewardLedgerEntry.create({
            data: {
              userId,
              walletId: wallet.id,
              deltaPoints: 10,
              reason: REWARD_REASONS.ADJUSTMENT,
              sourceType: REWARD_SOURCE_TYPES.DEV_TOOL,
              idempotencyKey: 'race-probe',
              balanceAfter: 10,
            },
          });
          return 'inserted';
        });

      const outcomes = await Promise.allSettled([
        unlockedAttempt(),
        unlockedAttempt(),
      ]);

      // Exactly one caller is REJECTED outright. This is the concrete reason
      // `appendEntry` locks first instead of relying on the unique constraint
      // and catching `P2002`: the violation aborts the whole Postgres
      // transaction, so the loser cannot recover by reading the winner's row
      // — every statement after the failure fails too. Under the lock (the
      // tests above) both callers succeed and one reports `replayed`.
      expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    });
  });

  describe('database backstops', () => {
    it('CRITICAL: Postgres refuses a negative balance even if application code is bypassed', async () => {
      // The application check is the primary control; this proves the
      // last-resort constraint is actually installed, so a future writer that
      // forgets the check cannot mint a negative balance.
      await credit(10, 'seed');

      await expect(
        prisma.$executeRaw`UPDATE "RewardWallet" SET "balancePoints" = -1 WHERE "userId" = ${userId}`,
      ).rejects.toThrow(/RewardWallet_balancePoints_nonnegative/);
    });

    it('CRITICAL: Postgres refuses a zero-delta ledger row', async () => {
      const wallet = await prisma.rewardWallet.create({ data: { userId } });

      await expect(
        prisma.$executeRaw`
          INSERT INTO "RewardLedgerEntry"
            ("id", "userId", "walletId", "deltaPoints", "reason", "sourceType", "idempotencyKey", "balanceAfter", "createdAt")
          VALUES
            ('zero-delta-probe', ${userId}, ${wallet.id}, 0, 'ADJUSTMENT', 'DEV_TOOL', 'zero-probe', 0, NOW())`,
      ).rejects.toThrow(/RewardLedgerEntry_deltaPoints_nonzero/);
    });

    it('CRITICAL: the (userId, idempotencyKey) unique index is really there', async () => {
      const first = await credit(10, 'dup-probe');

      await expect(
        prisma.rewardLedgerEntry.create({
          data: {
            userId,
            walletId: first.entry.walletId,
            deltaPoints: 10,
            reason: REWARD_REASONS.ADJUSTMENT,
            sourceType: REWARD_SOURCE_TYPES.DEV_TOOL,
            idempotencyKey: 'dup-probe',
            balanceAfter: 20,
          },
        }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    });
  });

  describe('reconcile', () => {
    it('reports consistency after a mixed series of movements', async () => {
      await credit(100, 'r1');
      await credit(250, 'r2');
      await prisma.$transaction((tx) =>
        service.appendEntry(tx, {
          userId,
          deltaPoints: -125,
          reason: REWARD_REASONS.VIP_REDEMPTION,
          sourceType: REWARD_SOURCE_TYPES.REDEMPTION,
          idempotencyKey: 'r3',
        }),
      );

      const report = await service.reconcile(userId);
      expect(report).toEqual({
        walletBalancePoints: 225,
        ledgerBalancePoints: 225,
        walletLifetimeEarnedPoints: 350,
        ledgerLifetimeEarnedPoints: 350,
        isConsistent: true,
      });
    });

    it('CRITICAL: detects a projection that has drifted from the ledger', async () => {
      // The contract says "if the projection and the ledger sum ever
      // disagree, the ledger wins". That rule is only meaningful if a
      // disagreement is detectable, so this forces one and checks it is seen.
      await credit(100, 'drift');
      await prisma.$executeRaw`UPDATE "RewardWallet" SET "balancePoints" = 999 WHERE "userId" = ${userId}`;

      const report = await service.reconcile(userId);
      expect(report.isConsistent).toBe(false);
      expect(report.walletBalancePoints).toBe(999);
      expect(report.ledgerBalancePoints).toBe(100);
    });

    it('reports a consistent zero for a user with no wallet at all', async () => {
      expect(await service.reconcile(userId)).toMatchObject({
        isConsistent: true,
        walletBalancePoints: 0,
        ledgerBalancePoints: 0,
      });
    });
  });
});
