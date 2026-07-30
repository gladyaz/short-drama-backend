import { PrismaService } from '../prisma/prisma.service';
import {
  ANALYTICS_EVENT_RETENTION_DAYS,
  AUTH_AUDIT_EVENT_RETENTION_DAYS,
  PASSWORD_RESET_TOKEN_RETENTION_DAYS,
  SESSION_RETENTION_DAYS,
  WATCH_PROGRESS_RETENTION_DAYS,
} from './retention.constants';
import { RetentionService } from './retention.service';
import { dayGranularityCutoff } from './retention.util';

/**
 * Phase 12, work unit 12D-B1: fast, DB-free coverage against a fully mocked
 * `PrismaService`. Complements (does not replace) `retention.integration
 * .spec.ts`'s real-Postgres proof — this file exists specifically so the
 * two safety-critical properties this work unit requires to be proven
 * non-vacuous by mutation (dry-run-deletes-nothing, the production guard)
 * have a FAST, deterministic home, and so the deleted-account-residue
 * orphan-detection logic can be exercised against a scenario (a genuine
 * orphan row) that is structurally impossible to construct against a real,
 * FK-constrained Postgres database (see `retention.service.ts`'s
 * `processDeletedAccountResidue` doc comment, and
 * `retention.integration.spec.ts`'s dedicated proof that Postgres itself
 * rejects an attempt to create one).
 *
 * Fast-follow (independent `test-reviewer` pass on work unit 12D-B1,
 * MEDIUM): `assertDestructiveRetentionAllowed` (called by `RetentionService
 * .run` for every `commit: true` case below) now ALSO requires `DATABASE_URL`
 * to resolve to the same database as `DATABASE_URL_TEST` — see
 * `retention-env-guard.ts`/`retention-env-guard.spec.ts` for that gate's own
 * dedicated coverage. This file's `beforeEach` aligns `DATABASE_URL` to
 * `DATABASE_URL_TEST` by default so every test below keeps exercising ONLY
 * the dimension it was written for (NODE_ENV, or pure orphan-detection query
 * shape) — mocked Prisma never issues a real query either way, so this
 * alignment is process-env bookkeeping only, not a live connection.
 */
function createMockDelegate() {
  return {
    count: jest.fn().mockResolvedValue(0),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    findMany: jest.fn().mockResolvedValue([]),
  };
}

function createMockPrisma() {
  return {
    session: createMockDelegate(),
    authAuditEvent: createMockDelegate(),
    analyticsEvent: createMockDelegate(),
    watchProgress: createMockDelegate(),
    userVideoInteraction: createMockDelegate(),
    entitlement: createMockDelegate(),
    passwordResetToken: createMockDelegate(),
    accountLockout: createMockDelegate(),
    user: createMockDelegate(),
  };
}

type MockPrisma = ReturnType<typeof createMockPrisma>;

describe('RetentionService (mocked Prisma, no real database)', () => {
  let mockPrisma: MockPrisma;
  let service: RetentionService;
  let originalNodeEnv: string | undefined;
  let originalDatabaseUrl: string | undefined;

  beforeEach(() => {
    mockPrisma = createMockPrisma();
    service = new RetentionService(mockPrisma as unknown as PrismaService);
    originalNodeEnv = process.env.NODE_ENV;
    originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  /**
   * Mutation-proof target #1 (see this work unit's report). To reproduce:
   * temporarily change `RetentionService`'s `commit ? await ...deleteMany() : 0`
   * ternaries to unconditionally call `deleteMany`, re-run this suite,
   * confirm every assertion below fails, then restore the source
   * byte-for-byte (verified via `git diff` producing no output).
   */
  describe('dry run (commit: false, the default) deletes nothing', () => {
    it('never calls deleteMany on any model when commit is omitted entirely', async () => {
      await service.run();

      expect(mockPrisma.session.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.authAuditEvent.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.analyticsEvent.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.watchProgress.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.userVideoInteraction.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.entitlement.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.passwordResetToken.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.accountLockout.deleteMany).not.toHaveBeenCalled();
    });

    it('never calls deleteMany when commit is explicitly false', async () => {
      await service.run({ commit: false });

      expect(mockPrisma.session.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.authAuditEvent.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.analyticsEvent.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.watchProgress.deleteMany).not.toHaveBeenCalled();
    });

    it('never calls deleteMany for any non-boolean-true commit value (mirrors the AccountDeletionDto "must be literal true" precedent)', async () => {
      await service.run({ commit: 'true' as unknown as boolean });

      expect(mockPrisma.session.deleteMany).not.toHaveBeenCalled();
    });

    it('every target reports deletedCount 0 in a dry run, even when rows matched', async () => {
      mockPrisma.session.count.mockResolvedValue(3);
      mockPrisma.passwordResetToken.count.mockResolvedValue(4);
      mockPrisma.authAuditEvent.count.mockResolvedValue(2);
      mockPrisma.analyticsEvent.count.mockResolvedValue(5);
      mockPrisma.watchProgress.count.mockResolvedValue(1);

      const report = await service.buildReport();

      for (const target of report.targets) {
        expect(target.deletedCount).toBe(0);
      }
      expect(
        report.targets.find((t) => t.target === 'session')?.matchedCount,
      ).toBe(3);
      expect(
        report.targets.find((t) => t.target === 'passwordResetToken')
          ?.matchedCount,
      ).toBe(4);
    });
  });

  /**
   * Mutation-proof target #2 (see this work unit's report). To reproduce:
   * temporarily remove/no-op the `if (commit) { assertDestructiveRetentionAllowed(); }`
   * call in `RetentionService.run`, re-run this suite, confirm every
   * assertion below fails, then restore the source byte-for-byte.
   */
  describe('the production guard actually refuses commit mode', () => {
    it('throws and calls zero Prisma methods when NODE_ENV is unset', async () => {
      delete process.env.NODE_ENV;

      await expect(service.run({ commit: true })).rejects.toThrow(
        /Refusing to run retention cleanup destructively/,
      );

      expect(mockPrisma.session.count).not.toHaveBeenCalled();
      expect(mockPrisma.session.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.passwordResetToken.count).not.toHaveBeenCalled();
      expect(mockPrisma.passwordResetToken.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.authAuditEvent.count).not.toHaveBeenCalled();
      expect(mockPrisma.analyticsEvent.count).not.toHaveBeenCalled();
      expect(mockPrisma.watchProgress.count).not.toHaveBeenCalled();
      expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
    });

    it('throws when NODE_ENV=production, the exact value the pre-existing env.validation.ts check also blocks', async () => {
      process.env.NODE_ENV = 'production';

      await expect(service.run({ commit: true })).rejects.toThrow();
      expect(mockPrisma.session.deleteMany).not.toHaveBeenCalled();
    });

    it('throws for an unrecognized NODE_ENV value (not merely "not production")', async () => {
      process.env.NODE_ENV = 'staging';

      await expect(service.run({ commit: true })).rejects.toThrow();
      expect(mockPrisma.session.deleteMany).not.toHaveBeenCalled();
    });

    /**
     * Fast-follow (independent `test-reviewer` pass, MEDIUM): proves the
     * second, independent database-identity gate on its own — an allowed
     * NODE_ENV is deliberately NOT enough by itself, matching this fast
     * follow's exact finding (`NODE_ENV=development npm run retention
     * -- --commit` previously deleted against whatever `DATABASE_URL`
     * resolved to, e.g. `short_drama_dev`). Zero Prisma calls proves this
     * refusal happens before any query, same as the NODE_ENV cases above.
     */
    it('throws and calls zero Prisma methods when DATABASE_URL does not match DATABASE_URL_TEST, even though NODE_ENV=development is allowed', async () => {
      process.env.NODE_ENV = 'development';
      process.env.DATABASE_URL =
        'postgresql://user:password@localhost:5433/short_drama_dev';

      await expect(service.run({ commit: true })).rejects.toThrow(
        /Refusing to run retention cleanup destructively/,
      );

      expect(mockPrisma.session.count).not.toHaveBeenCalled();
      expect(mockPrisma.session.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.passwordResetToken.count).not.toHaveBeenCalled();
      expect(mockPrisma.passwordResetToken.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.authAuditEvent.count).not.toHaveBeenCalled();
      expect(mockPrisma.analyticsEvent.count).not.toHaveBeenCalled();
      expect(mockPrisma.watchProgress.count).not.toHaveBeenCalled();
      expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
    });

    it('proceeds (calls deleteMany) once NODE_ENV=test', async () => {
      process.env.NODE_ENV = 'test';

      await service.run({ commit: true });

      expect(mockPrisma.session.deleteMany).toHaveBeenCalled();
    });
  });

  describe('cutoff computation', () => {
    it("computes each target report cutoff via dayGranularityCutoff with that target's own window constant", async () => {
      const now = new Date('2027-03-15T09:30:00.000Z');

      const report = await service.buildReport(now);

      const byTarget = Object.fromEntries(
        report.targets.map((target) => [target.target, target.cutoff]),
      );

      expect(byTarget.session?.getTime()).toBe(
        dayGranularityCutoff(now, SESSION_RETENTION_DAYS).getTime(),
      );
      expect(byTarget.passwordResetToken?.getTime()).toBe(
        dayGranularityCutoff(
          now,
          PASSWORD_RESET_TOKEN_RETENTION_DAYS,
        ).getTime(),
      );
      expect(byTarget.authAuditEvent?.getTime()).toBe(
        dayGranularityCutoff(now, AUTH_AUDIT_EVENT_RETENTION_DAYS).getTime(),
      );
      expect(byTarget.analyticsEvent?.getTime()).toBe(
        dayGranularityCutoff(now, ANALYTICS_EVENT_RETENTION_DAYS).getTime(),
      );
      expect(byTarget.watchProgress?.getTime()).toBe(
        dayGranularityCutoff(now, WATCH_PROGRESS_RETENTION_DAYS).getTime(),
      );
      expect(byTarget.deletedAccountResidue).toBeNull();
    });
  });

  describe('deleted-account residue: query construction (a real orphan cannot be constructed against a real FK-constrained database — see retention.integration.spec.ts)', () => {
    it('never fetches an AnalyticsEvent/AuthAuditEvent row with a null userId as an orphan candidate — the query itself excludes them', async () => {
      await service.buildReport();

      expect(mockPrisma.analyticsEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: { not: null } } }),
      );
      expect(mockPrisma.authAuditEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: { not: null } } }),
      );
    });

    it('flags a userId as an orphan when it does not resolve to an existing User, and deletes ONLY that id in commit mode', async () => {
      process.env.NODE_ENV = 'test';
      mockPrisma.session.findMany.mockResolvedValue([
        { userId: 'real-user-1' },
        { userId: 'ghost-user-1' },
      ]);
      // Only "real-user-1" resolves — simulates what would be a genuine
      // orphan if Postgres's FK constraint did not already forbid it.
      mockPrisma.user.findMany.mockResolvedValue([{ id: 'real-user-1' }]);
      // `session.deleteMany` is shared by TWO call sites in a full `run()`
      // (the plain session-TTL target, and this residue check) — distinguish
      // them by `where` shape so this assertion reflects ONLY the residue
      // deletion, not an incidental default from the other call site.
      mockPrisma.session.deleteMany.mockImplementation(
        (args: { where?: { userId?: { in?: string[] } } }) => {
          const orphanIdsArg = args?.where?.userId?.in;
          return Promise.resolve({ count: orphanIdsArg?.length ?? 0 });
        },
      );

      const report = await service.run({ commit: true });

      const residue = report.targets.find(
        (t) => t.target === 'deletedAccountResidue',
      );
      const sessionDetail = residue?.residueDetails?.find(
        (d) => d.model === 'session',
      );

      expect(sessionDetail?.matchedCount).toBe(1);
      expect(sessionDetail?.deletedCount).toBe(1);
      expect(mockPrisma.session.deleteMany).toHaveBeenCalledWith({
        where: { userId: { in: ['ghost-user-1'] } },
      });
    });

    it('does not call deleteMany for a model with zero orphans found', async () => {
      process.env.NODE_ENV = 'test';
      mockPrisma.session.findMany.mockResolvedValue([
        { userId: 'real-user-1' },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([{ id: 'real-user-1' }]);

      await service.run({ commit: true });

      // The residue deleteMany is distinguished from the plain session
      // deleteMany (`where: { OR: [...] }`) by its `userId: { in: [...] }`
      // shape — asserting the exact call args proves this is the residue
      // path, not merely "deleteMany was called at all" (which the plain
      // session TTL target also legitimately triggers in commit mode).
      expect(mockPrisma.session.deleteMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: { in: [] } } }),
      );
    });
  });
});
