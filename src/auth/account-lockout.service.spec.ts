import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import {
  TEST_FIXTURE_NAMESPACE,
  fixtureEmail,
} from '../common/testing/fixture-namespace.helpers';
import { AccountLockoutService } from './account-lockout.service';
import {
  LOCKOUT_DURATION_MS,
  LOCKOUT_FAILURE_THRESHOLD,
  LOCKOUT_WINDOW_MS,
} from './auth.constants';

/**
 * Integration-style spec (Phase 12, work unit 12A-B1), following the
 * `EntitlementsService`/`InteractionsService`/`AuthService` precedent: real
 * `PrismaService` against the project's dev Postgres database, self-cleaning
 * via `afterEach`.
 */
describe('AccountLockoutService', () => {
  let service: AccountLockoutService;
  let prisma: PrismaService;

  // Auth test-stability slice — see `fixture-namespace.helpers.ts`.
  const testIdPrefix = TEST_FIXTURE_NAMESPACE;
  let userId: string;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AccountLockoutService, PrismaService],
    }).compile();

    service = module.get<AccountLockoutService>(AccountLockoutService);
    prisma = module.get<PrismaService>(PrismaService);
    await prisma.onModuleInit();

    const user = await prisma.user.create({
      data: {
        email: fixtureEmail('lockout'),
        passwordHash: 'irrelevant-for-this-spec',
      },
    });
    userId = user.id;
  });

  afterEach(async () => {
    await prisma.accountLockout.deleteMany({
      where: { user: { email: { startsWith: testIdPrefix } } },
    });
    await prisma.user.deleteMany({
      where: { email: { startsWith: testIdPrefix } },
    });
    await prisma.onModuleDestroy();
  });

  describe('isLocked', () => {
    it('is false when no AccountLockout row exists yet', async () => {
      await expect(service.isLocked(userId)).resolves.toBe(false);
    });

    it('is false when a row exists but lockedUntil is null', async () => {
      await prisma.accountLockout.create({
        data: { userId, failedCount: 3, windowStartedAt: new Date() },
      });

      await expect(service.isLocked(userId)).resolves.toBe(false);
    });

    it('is true while lockedUntil is in the future', async () => {
      await prisma.accountLockout.create({
        data: {
          userId,
          failedCount: LOCKOUT_FAILURE_THRESHOLD,
          windowStartedAt: new Date(),
          lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS),
        },
      });

      await expect(service.isLocked(userId)).resolves.toBe(true);
    });

    it('is false once lockedUntil has passed (lock window elapsed)', async () => {
      await prisma.accountLockout.create({
        data: {
          userId,
          failedCount: LOCKOUT_FAILURE_THRESHOLD,
          windowStartedAt: new Date(Date.now() - LOCKOUT_WINDOW_MS - 1000),
          lockedUntil: new Date(Date.now() - 1000),
        },
      });

      await expect(service.isLocked(userId)).resolves.toBe(false);
    });
  });

  describe('recordFailure', () => {
    it('creates a fresh row with failedCount 1 and no lock on the first-ever failure', async () => {
      await service.recordFailure(userId);

      const row = await prisma.accountLockout.findUnique({
        where: { userId },
      });
      expect(row?.failedCount).toBe(1);
      expect(row?.lockedUntil).toBeNull();
      expect(row?.windowStartedAt).not.toBeNull();
    });

    it('increments failedCount within the same rolling window without locking below the threshold', async () => {
      for (let i = 0; i < LOCKOUT_FAILURE_THRESHOLD - 1; i += 1) {
        await service.recordFailure(userId);
      }

      const row = await prisma.accountLockout.findUnique({
        where: { userId },
      });
      expect(row?.failedCount).toBe(LOCKOUT_FAILURE_THRESHOLD - 1);
      expect(row?.lockedUntil).toBeNull();
    });

    it('locks the account for LOCKOUT_DURATION_MS exactly once failedCount reaches the threshold', async () => {
      const beforeLock = Date.now();

      for (let i = 0; i < LOCKOUT_FAILURE_THRESHOLD; i += 1) {
        await service.recordFailure(userId);
      }

      const row = await prisma.accountLockout.findUnique({
        where: { userId },
      });
      expect(row?.failedCount).toBe(LOCKOUT_FAILURE_THRESHOLD);
      expect(row?.lockedUntil).not.toBeNull();
      expect(row!.lockedUntil!.getTime()).toBeGreaterThanOrEqual(
        beforeLock + LOCKOUT_DURATION_MS,
      );

      await expect(service.isLocked(userId)).resolves.toBe(true);
    });

    /**
     * Regression test for the lost-update race documented in the Phase 12
     * work unit 12A-B1 review: a naive `find → compute → upsert` inside a
     * `$transaction` under Postgres's default READ COMMITTED isolation lets
     * concurrent `recordFailure` calls for the SAME account all read the
     * same stale `failedCount` and each write back `staleCount + 1`, so N
     * genuinely concurrent failed attempts collapse into far fewer than N
     * counted failures — undercounting badly enough that the account may
     * never reach `LOCKOUT_FAILURE_THRESHOLD` at all. This fires real
     * concurrent `recordFailure()` calls via `Promise.all` (mirroring the
     * `InteractionsService` `unlike()` concurrency regression precedent) and
     * asserts the final count is exactly the number of concurrent failures,
     * with the account locked once that count reaches the threshold.
     */
    it('correctly increments failedCount to exactly N under N concurrent recordFailure calls, locking once N >= threshold', async () => {
      const concurrentFailureCount = 20;

      await Promise.all(
        Array.from({ length: concurrentFailureCount }, () =>
          service.recordFailure(userId),
        ),
      );

      const row = await prisma.accountLockout.findUnique({
        where: { userId },
      });
      expect(row?.failedCount).toBe(concurrentFailureCount);
      expect(row?.lockedUntil).not.toBeNull();
      await expect(service.isLocked(userId)).resolves.toBe(true);
    });

    it('starts a brand new window (failedCount reset to 1) once the prior window is older than LOCKOUT_WINDOW_MS', async () => {
      await prisma.accountLockout.create({
        data: {
          userId,
          failedCount: LOCKOUT_FAILURE_THRESHOLD - 1,
          windowStartedAt: new Date(Date.now() - LOCKOUT_WINDOW_MS - 1000),
        },
      });

      await service.recordFailure(userId);

      const row = await prisma.accountLockout.findUnique({
        where: { userId },
      });
      // A stale window resets the count instead of adding to it — one more
      // failure after an expired window is failedCount 1, not
      // LOCKOUT_FAILURE_THRESHOLD.
      expect(row?.failedCount).toBe(1);
      expect(row?.lockedUntil).toBeNull();
    });
  });

  describe('recordSuccess', () => {
    it('is a no-op that creates no row when the account has never failed a login', async () => {
      await service.recordSuccess(userId);

      const row = await prisma.accountLockout.findUnique({
        where: { userId },
      });
      expect(row).toBeNull();
    });

    it('resets failedCount/windowStartedAt/lockedUntil after prior failures', async () => {
      await prisma.accountLockout.create({
        data: {
          userId,
          failedCount: LOCKOUT_FAILURE_THRESHOLD,
          windowStartedAt: new Date(),
          lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS),
        },
      });

      await service.recordSuccess(userId);

      const row = await prisma.accountLockout.findUnique({
        where: { userId },
      });
      expect(row?.failedCount).toBe(0);
      expect(row?.windowStartedAt).toBeNull();
      expect(row?.lockedUntil).toBeNull();
      await expect(service.isLocked(userId)).resolves.toBe(false);
    });
  });
});
