import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { HttpStatus } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { RootConfig } from '../config/configuration';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { AccountLockoutService } from './account-lockout.service';
import { AuthAuditService } from './auth-audit.service';
import { bcryptTestBudgetMs } from '../common/testing/bcrypt-test-budget.helpers';
import {
  TEST_FIXTURE_NAMESPACE,
  fixtureEmail,
} from '../common/testing/fixture-namespace.helpers';
import { AuthService } from './auth.service';

const TEST_AUTH_CONFIG = {
  jwtAccessSecret: 'test-access-secret-not-a-real-secret',
  jwtRefreshSecret: 'test-refresh-secret-not-a-real-secret',
  authAuditIpHashSecret: 'test-auth-audit-ip-hash-secret-not-a-real-secret',
};

/**
 * Phase 12, work unit 12C-B1: `AuthService.deleteAccount`.
 *
 * Unlike every other `*.spec.ts` file in this repo — which intentionally
 * share `DATABASE_URL` (the dev database), per `auth.service.spec.ts`'s own
 * documented precedent — this file performs a genuine, hard, non-additive
 * `DELETE FROM "User"` for real. The runbook for this work unit binds
 * account-deletion tests to run ONLY against the isolated
 * `DATABASE_URL_TEST` database, failing closed if it is unset, and never
 * against `short_drama_dev`. The redirect below happens inside `beforeAll`,
 * BEFORE `Test.createTestingModule(...).compile()` ever constructs a real
 * `PrismaService`/`PrismaClient` — which resolves its datasource URL from
 * `process.env.DATABASE_URL` at CONSTRUCTION time, the same property
 * `test/jest-e2e.setup.ts` already relies on for the identical reason — and
 * is restored in `afterAll` so it can never leak `DATABASE_URL_TEST` into any
 * OTHER `*.spec.ts` file sharing this Jest worker process afterward.
 */
/**
 * Auth test-stability slice: replaces Jest's inherited 5000ms default. Every
 * test here drives REAL cost-factor-12 bcrypt hashing through the real
 * `AuthService`; the most expensive one performs 6 such operations, which is
 * already a large fraction of 5000ms on a busy machine. See
 * `../common/testing/bcrypt-test-budget.helpers.ts` — a harness hang-detector
 * budget, NOT a business-security timeout.
 */
jest.setTimeout(bcryptTestBudgetMs(6));

describe('AuthService.deleteAccount', () => {
  let service: AuthService;
  let prisma: PrismaService;
  let originalDatabaseUrl: string | undefined;
  // Phase 12, work unit 12E-B1: a genuinely SCRUBBED `AuthAuditEvent` row
  // has `userId`/`ipHash`/`userAgent`/`metadata` all null by design — which
  // means, by design, it can no longer be found via ANY of the marker-based
  // `deleteMany` cleanup queries below (that IS the feature). Tests that
  // create a row they expect to end up scrubbed push its `id` here so
  // `afterEach` can still find and remove it directly, instead of leaking
  // permanently-orphaned rows into `short_drama_test` on every run.
  let scrubbedAuditEventIds: string[];

  // Kept short deliberately: `@IsEmail()` (via `validator.js`) enforces the
  // RFC 5321 64-character local-part limit, and this prefix is combined with
  // a label + timestamp + random suffix per generated address below (see
  // `auth-rate-limit-lockout.e2e-spec.ts`'s identical precedent).
  // Auth test-stability slice: was the hardcoded literal `'ad-svc+12cb1'`,
  // identical in every worktree of this repo and therefore shared by any
  // concurrent Jest run against the same database — see
  // `fixture-namespace.helpers.ts`. Every `${emailPrefix}-...` marker below
  // inherits the per-run namespace unchanged.
  const emailPrefix = TEST_FIXTURE_NAMESPACE;
  const uniqueEmail = (label: string): string => fixtureEmail(`ad-${label}`);

  beforeAll(() => {
    originalDatabaseUrl = process.env.DATABASE_URL;

    if (!process.env.DATABASE_URL_TEST) {
      throw new Error(
        'DATABASE_URL_TEST is not set in .env — account-deletion tests must ' +
          'run against the dedicated short_drama_test database, never ' +
          'DATABASE_URL (dev). Copy .env.example and set DATABASE_URL_TEST ' +
          'before running npm test.',
      );
    }

    process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  });

  afterAll(() => {
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [JwtModule.register({})],
      providers: [
        AuthService,
        PrismaService,
        AccountLockoutService,
        AuthAuditService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(TEST_AUTH_CONFIG) },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    prisma = module.get<PrismaService>(PrismaService);
    await prisma.onModuleInit();
    scrubbedAuditEventIds = [];
  });

  afterEach(async () => {
    // `account_deletion_success` is deliberately emitted WITHOUT a `userId`
    // (see `AuthService.deleteAccount`'s doc comment), so it survives a
    // deleted account with no relation to join through — matching
    // `auth.service.spec.ts`'s existing orphan-cleanup precedent, these rows
    // are found via the marker `userAgent` every test below passes.
    await prisma.authAuditEvent.deleteMany({
      where: { userAgent: { startsWith: emailPrefix } },
    });
    await prisma.authAuditEvent.deleteMany({
      where: { user: { email: { startsWith: emailPrefix } } },
    });
    // Phase 12, work unit 12E-B1: rows a test expects to end up genuinely
    // SCRUBBED (userId/ipHash/userAgent all null) can't be found by either
    // query above — see this file's `scrubbedAuditEventIds` doc comment.
    if (scrubbedAuditEventIds.length > 0) {
      await prisma.authAuditEvent.deleteMany({
        where: { id: { in: scrubbedAuditEventIds } },
      });
    }
    await prisma.analyticsEvent.deleteMany({
      where: { eventName: { startsWith: emailPrefix } },
    });
    await prisma.accountLockout.deleteMany({
      where: { user: { email: { startsWith: emailPrefix } } },
    });
    await prisma.passwordResetToken.deleteMany({
      where: { user: { email: { startsWith: emailPrefix } } },
    });
    await prisma.entitlement.deleteMany({
      where: { user: { email: { startsWith: emailPrefix } } },
    });
    await prisma.watchProgress.deleteMany({
      where: { user: { email: { startsWith: emailPrefix } } },
    });
    await prisma.userVideoInteraction.deleteMany({
      where: { user: { email: { startsWith: emailPrefix } } },
    });
    await prisma.session.deleteMany({
      where: { user: { email: { startsWith: emailPrefix } } },
    });
    await prisma.user.deleteMany({
      where: { email: { startsWith: emailPrefix } },
    });
    await prisma.onModuleDestroy();
  });

  /** Registers a fresh account and returns its id/tokens. */
  async function registerUser(label: string, password: string) {
    const email = uniqueEmail(label);
    const result = await service.register({ email, password });
    return { email, result };
  }

  it('deletes the account: user row is gone, all sessions gone, and it can no longer log in', async () => {
    const password = 'correct-horse-battery';
    const { email, result } = await registerUser('success', password);
    // A second session ("second device") — must ALSO be gone afterward,
    // not merely revoked (the delete cascades the whole table, a strictly
    // stronger outcome than revocation).
    await service.login({ email, password });

    await service.deleteAccount(
      result.user.id,
      { currentPassword: password, confirmDeletion: true },
      { userAgent: `${emailPrefix}-success-agent` },
    );

    const user = await prisma.user.findUnique({
      where: { id: result.user.id },
    });
    expect(user).toBeNull();

    await expect(service.login({ email, password })).rejects.toMatchObject({
      code: AppErrorCode.INVALID_CREDENTIALS,
      status: HttpStatus.UNAUTHORIZED,
    } as Partial<AppException>);
  });

  it('rejects a wrong current password with the generic INVALID_CREDENTIALS error and leaves the account fully intact', async () => {
    const password = 'correct-horse-battery';
    const { email, result } = await registerUser('wrong-password', password);

    await expect(
      service.deleteAccount(
        result.user.id,
        { currentPassword: 'totally-wrong-password', confirmDeletion: true },
        { userAgent: `${emailPrefix}-wrong-password-agent` },
      ),
    ).rejects.toMatchObject({
      code: AppErrorCode.INVALID_CREDENTIALS,
      status: HttpStatus.UNAUTHORIZED,
    } as Partial<AppException>);

    const user = await prisma.user.findUnique({
      where: { id: result.user.id },
    });
    expect(user).not.toBeNull();
    // The account still logs in normally — nothing about it was touched.
    await expect(service.login({ email, password })).resolves.toBeDefined();

    const auditRows = await prisma.authAuditEvent.findMany({
      where: {
        userId: result.user.id,
        event: 'account_deletion_failed',
      },
    });
    expect(auditRows).toHaveLength(1);
    expect((auditRows[0].metadata as { reason?: string } | null)?.reason).toBe(
      'invalid_current_password',
    );
  });

  it('refuses deletion for a non-"user" role account with ACCOUNT_DELETION_FORBIDDEN and leaves the account fully intact', async () => {
    const password = 'correct-horse-battery';
    const { result } = await registerUser('non-user-role', password);
    await prisma.user.update({
      where: { id: result.user.id },
      data: { role: 'admin' },
    });

    await expect(
      service.deleteAccount(
        result.user.id,
        { currentPassword: password, confirmDeletion: true },
        { userAgent: `${emailPrefix}-role-refused-agent` },
      ),
    ).rejects.toMatchObject({
      code: AppErrorCode.ACCOUNT_DELETION_FORBIDDEN,
      status: HttpStatus.FORBIDDEN,
    } as Partial<AppException>);

    const user = await prisma.user.findUnique({
      where: { id: result.user.id },
    });
    expect(user).not.toBeNull();
    expect(user?.role).toBe('admin');

    const auditRows = await prisma.authAuditEvent.findMany({
      where: {
        userId: result.user.id,
        event: 'account_deletion_failed',
      },
    });
    expect(auditRows).toHaveLength(1);
    expect((auditRows[0].metadata as { reason?: string } | null)?.reason).toBe(
      'role_not_allowed',
    );
  });

  /**
   * The order-of-checks property `AuthService.deleteAccount`'s doc comment
   * claims is deliberate: a caller must already know the correct password
   * before the endpoint will reveal "this account is privileged" via a
   * distinct error code. Proven non-vacuous by mutation below (see the
   * "mutation coverage" describe block).
   */
  it('order-of-checks: a privileged account presented with a WRONG password gets INVALID_CREDENTIALS, not ACCOUNT_DELETION_FORBIDDEN', async () => {
    const password = 'correct-horse-battery';
    const { result } = await registerUser('order-of-checks', password);
    await prisma.user.update({
      where: { id: result.user.id },
      data: { role: 'admin' },
    });

    await expect(
      service.deleteAccount(
        result.user.id,
        { currentPassword: 'totally-wrong-password', confirmDeletion: true },
        { userAgent: `${emailPrefix}-order-of-checks-agent` },
      ),
    ).rejects.toMatchObject({
      code: AppErrorCode.INVALID_CREDENTIALS,
      status: HttpStatus.UNAUTHORIZED,
    } as Partial<AppException>);
  });

  it('is idempotent: a second call for an already-deleted account gets the same clean INVALID_ACCESS_TOKEN 401 every other "user vanished" path already uses, never an unhandled error', async () => {
    const password = 'correct-horse-battery';
    const { result } = await registerUser('idempotent', password);

    await service.deleteAccount(
      result.user.id,
      { currentPassword: password, confirmDeletion: true },
      { userAgent: `${emailPrefix}-idempotent-agent` },
    );

    // Second call: same userId, same (now-stale) password — must not throw
    // an unhandled 500, and must not attempt a second bcrypt.compare against
    // a user row that no longer exists.
    await expect(
      service.deleteAccount(
        result.user.id,
        { currentPassword: password, confirmDeletion: true },
        { userAgent: `${emailPrefix}-idempotent-agent` },
      ),
    ).rejects.toMatchObject({
      code: AppErrorCode.INVALID_ACCESS_TOKEN,
      status: HttpStatus.UNAUTHORIZED,
    } as Partial<AppException>);
  });

  describe('cascade + anonymization at the DB level', () => {
    it('removes every cascade-configured owned row; AnalyticsEvent survives anonymized via SET NULL; AuthAuditEvent survives via the explicit pre-delete scrub (Phase 12E-B1) with no identifying data retained', async () => {
      const password = 'correct-horse-battery';
      const ip = '198.51.100.42';
      const { email, result } = await registerUser('cascade', password);
      const userId = result.user.id;

      // A second session, beyond the one `register` itself already created.
      await service.login({ email, password });

      await prisma.userVideoInteraction.create({
        data: { userId, videoId: `${emailPrefix}-video-1`, isLiked: true },
      });
      await prisma.watchProgress.create({
        data: {
          userId,
          seriesId: `${emailPrefix}-series-1`,
          lastWatchedVideoId: `${emailPrefix}-video-1`,
          lastWatchedEpisodeNumber: 1,
          positionSeconds: 42,
        },
      });
      await prisma.entitlement.create({
        data: { userId, tier: 'premium', source: 'test-fixture' },
      });
      await prisma.passwordResetToken.create({
        data: {
          userId,
          tokenHash: `${emailPrefix}-reset-token-hash`,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      await prisma.accountLockout.create({
        data: { userId, failedCount: 3 },
      });
      // A pre-deletion AuthAuditEvent that DOES reference this user (e.g. a
      // real login-failure event) — must survive the delete, scrubbed. Sets
      // `ipHash`/`metadata` directly (not just `userAgent`) so this
      // composition test covers all three scrubbed columns, not only the
      // one the ORIGINAL (pre-12E-B1) version of this test happened to set.
      const preexistingAuditRow = await prisma.authAuditEvent.create({
        data: {
          userId,
          event: 'login_failed',
          userAgent: `${emailPrefix}-preexisting-audit-agent`,
          ipHash: `${emailPrefix}-preexisting-audit-iphash`,
          metadata: { reason: 'invalid_password' },
        },
      });
      scrubbedAuditEventIds.push(preexistingAuditRow.id);
      // A pre-deletion AnalyticsEvent — must ALSO survive, anonymized.
      await prisma.analyticsEvent.create({
        data: {
          userId,
          eventName: `${emailPrefix}-video_play`,
          properties: { videoId: `${emailPrefix}-video-1` },
          platform: 'ios',
          clientTimestamp: new Date(),
        },
      });

      await service.deleteAccount(
        userId,
        { currentPassword: password, confirmDeletion: true },
        { ip, userAgent: `${emailPrefix}-cascade-agent` },
      );

      expect(
        await prisma.user.findUnique({ where: { id: userId } }),
      ).toBeNull();
      expect(await prisma.session.findMany({ where: { userId } })).toHaveLength(
        0,
      );
      expect(
        await prisma.userVideoInteraction.findMany({ where: { userId } }),
      ).toHaveLength(0);
      expect(
        await prisma.watchProgress.findMany({ where: { userId } }),
      ).toHaveLength(0);
      expect(
        await prisma.entitlement.findMany({ where: { userId } }),
      ).toHaveLength(0);
      expect(
        await prisma.passwordResetToken.findMany({ where: { userId } }),
      ).toHaveLength(0);
      expect(
        await prisma.accountLockout.findMany({ where: { userId } }),
      ).toHaveLength(0);

      // Scrubbed, not deleted: still present via its stable `id` (its
      // `userAgent` — the marker used to find it BEFORE this fix — is now
      // one of the columns that gets nulled, so it can no longer be used to
      // locate the row; that is the point). `userId`/`ipHash`/`userAgent`/
      // `metadata` are all null; `event`/`createdAt` survive untouched. See
      // the dedicated "AuthAuditEvent scrub" describe block below for the
      // full ordering/mutation proof — this assertion only confirms the
      // scrub composes correctly alongside every OTHER cascade this same
      // transaction relies on.
      const scrubbedAuditRow = await prisma.authAuditEvent.findUniqueOrThrow({
        where: { id: preexistingAuditRow.id },
      });
      expect(scrubbedAuditRow.userId).toBeNull();
      expect(scrubbedAuditRow.ipHash).toBeNull();
      expect(scrubbedAuditRow.userAgent).toBeNull();
      expect(scrubbedAuditRow.metadata).toBeNull();
      expect(scrubbedAuditRow.event).toBe('login_failed');
      expect(scrubbedAuditRow.createdAt).toEqual(preexistingAuditRow.createdAt);

      const analyticsRows = await prisma.analyticsEvent.findMany({
        where: { eventName: `${emailPrefix}-video_play` },
      });
      expect(analyticsRows).toHaveLength(1);
      expect(analyticsRows[0].userId).toBeNull();

      // No identifying value (email, raw IP) leaks into any surviving row.
      const serializedAudit = JSON.stringify(scrubbedAuditRow);
      const serializedAnalytics = JSON.stringify(analyticsRows);
      expect(serializedAudit).not.toContain(email);
      expect(serializedAudit).not.toContain(ip);
      expect(serializedAnalytics).not.toContain(email);
      expect(serializedAnalytics).not.toContain(ip);

      // The success event itself: no userId, and no identifying data.
      const successRows = await prisma.authAuditEvent.findMany({
        where: {
          userAgent: `${emailPrefix}-cascade-agent`,
          event: 'account_deletion_success',
        },
      });
      expect(successRows).toHaveLength(1);
      expect(successRows[0].userId).toBeNull();
      expect(JSON.stringify(successRows[0])).not.toContain(email);
      expect(JSON.stringify(successRows[0])).not.toContain(ip);
    });
  });

  /**
   * Phase 12, work unit 12E-B1 (DECISIONS.md 2026-07-30, decision 1,
   * resolving `TASK_QUEUE.md` follow-up 7). Dedicated coverage for the
   * `AuthAuditEvent` scrub itself, separate from the broader "cascade +
   * anonymization" composition test above.
   */
  describe('AuthAuditEvent scrub at deletion (Phase 12E-B1)', () => {
    it("scrubs the deleted account's OWN AuthAuditEvent rows — userId, ipHash, userAgent AND metadata all null; event and createdAt preserved", async () => {
      const password = 'correct-horse-battery';
      const ip = '203.0.113.77';
      const { email, result } = await registerUser('scrub', password);
      const userId = result.user.id;

      // A REAL pre-existing audit row, produced by the actual
      // `AuthAuditService.emit` -> `hashIp`/`sanitizeUserAgent` pipeline (a
      // genuine failed login), not a hand-crafted fixture — so `ipHash`
      // below is a real HMAC digest, exactly what a live attacker's or
      // operator's row would contain.
      await expect(
        service.login(
          { email, password: 'totally-wrong-password' },
          { ip, userAgent: `${emailPrefix}-scrub-preexisting-agent` },
        ),
      ).rejects.toMatchObject({
        code: AppErrorCode.INVALID_CREDENTIALS,
        status: HttpStatus.UNAUTHORIZED,
      } as Partial<AppException>);

      const preDeletionRow = await prisma.authAuditEvent.findFirstOrThrow({
        where: { userId, event: 'login_failed' },
      });
      scrubbedAuditEventIds.push(preDeletionRow.id);
      // Sanity: confirm the fixture genuinely has something to scrub before
      // asserting it got scrubbed — otherwise this test would pass
      // vacuously even with the scrub deleted entirely.
      expect(preDeletionRow.userId).toBe(userId);
      expect(preDeletionRow.ipHash).not.toBeNull();
      expect(preDeletionRow.ipHash).not.toBe(ip);
      expect(preDeletionRow.userAgent).toBe(
        `${emailPrefix}-scrub-preexisting-agent`,
      );
      expect(
        (preDeletionRow.metadata as { reason?: string } | null)?.reason,
      ).toBe('invalid_password');

      await service.deleteAccount(
        userId,
        { currentPassword: password, confirmDeletion: true },
        { userAgent: `${emailPrefix}-scrub-deletion-agent` },
      );

      const scrubbedRow = await prisma.authAuditEvent.findUniqueOrThrow({
        where: { id: preDeletionRow.id },
      });
      expect(scrubbedRow.userId).toBeNull();
      expect(scrubbedRow.ipHash).toBeNull();
      expect(scrubbedRow.userAgent).toBeNull();
      expect(scrubbedRow.metadata).toBeNull();
      // Preserved exactly, per decision 1's "preserve only the allowlisted
      // event type and the timestamp".
      expect(scrubbedRow.event).toBe('login_failed');
      expect(scrubbedRow.createdAt).toEqual(preDeletionRow.createdAt);
    });

    /**
     * THE ordering test. `AuthAuditEvent.userId` is `onDelete: SetNull`
     * (`prisma/schema.prisma`), and Postgres fires that cascade
     * SYNCHRONOUSLY, inside the same transaction, the instant
     * `tx.user.deleteMany` runs — so if the scrub were moved to AFTER that
     * call, its `where: { userId }` filter would already match zero rows
     * (the column is already `null`) and it would silently update nothing.
     * That failure mode produces NO thrown error and NO 500 — the deletion
     * still "succeeds" from the caller's point of view, which is exactly
     * why this needs its own explicit, named regression test rather than
     * relying on the ordering "obviously" being correct. Manually verified
     * non-vacuous: moving the scrub in `auth.service.ts` to after
     * `tx.user.deleteMany` makes this test fail (ipHash/userAgent/metadata
     * stay populated instead of turning null); restoring the original order
     * makes it pass again.
     */
    it('ORDERING (load-bearing): the scrub runs before the User row is deleted, not after', async () => {
      const password = 'correct-horse-battery';
      const { result } = await registerUser('scrub-ordering', password);
      const userId = result.user.id;

      const rowA = await prisma.authAuditEvent.create({
        data: {
          userId,
          event: 'login_failed',
          userAgent: `${emailPrefix}-scrub-ordering-agent-a`,
          ipHash: `${emailPrefix}-scrub-ordering-iphash-a`,
          metadata: { reason: 'invalid_password' },
        },
      });
      const rowB = await prisma.authAuditEvent.create({
        data: {
          userId,
          event: 'login_success',
          userAgent: `${emailPrefix}-scrub-ordering-agent-b`,
          ipHash: `${emailPrefix}-scrub-ordering-iphash-b`,
        },
      });
      scrubbedAuditEventIds.push(rowA.id, rowB.id);

      await service.deleteAccount(
        userId,
        { currentPassword: password, confirmDeletion: true },
        { userAgent: `${emailPrefix}-scrub-ordering-deletion-agent` },
      );

      const [scrubbedA, scrubbedB] = await Promise.all([
        prisma.authAuditEvent.findUniqueOrThrow({ where: { id: rowA.id } }),
        prisma.authAuditEvent.findUniqueOrThrow({ where: { id: rowB.id } }),
      ]);

      for (const row of [scrubbedA, scrubbedB]) {
        expect(row.userId).toBeNull();
        expect(row.ipHash).toBeNull();
        expect(row.userAgent).toBeNull();
        expect(row.metadata).toBeNull();
      }
      expect(scrubbedA.event).toBe('login_failed');
      expect(scrubbedB.event).toBe('login_success');
    });

    it("does NOT touch a DIFFERENT account's own AuthAuditEvent rows", async () => {
      const password = 'correct-horse-battery';
      const { result: deletedAccount } = await registerUser(
        'scrub-other-deleted',
        password,
      );
      const { result: otherAccount } = await registerUser(
        'scrub-other-survivor',
        password,
      );

      const otherAccountRow = await prisma.authAuditEvent.create({
        data: {
          userId: otherAccount.user.id,
          event: 'login_success',
          userAgent: `${emailPrefix}-scrub-other-survivor-agent`,
          ipHash: `${emailPrefix}-scrub-other-survivor-iphash`,
        },
      });

      await service.deleteAccount(
        deletedAccount.user.id,
        { currentPassword: password, confirmDeletion: true },
        { userAgent: `${emailPrefix}-scrub-other-deleted-deletion-agent` },
      );

      const untouchedRow = await prisma.authAuditEvent.findUniqueOrThrow({
        where: { id: otherAccountRow.id },
      });
      expect(untouchedRow.userId).toBe(otherAccount.user.id);
      expect(untouchedRow.ipHash).toBe(
        `${emailPrefix}-scrub-other-survivor-iphash`,
      );
      expect(untouchedRow.userAgent).toBe(
        `${emailPrefix}-scrub-other-survivor-agent`,
      );

      // The surviving account is otherwise completely unaffected too.
      const survivorUser = await prisma.user.findUnique({
        where: { id: otherAccount.user.id },
      });
      expect(survivorUser).not.toBeNull();
    });
  });

  /**
   * `account_deletion_success` must be emitted ONLY once the transaction has
   * actually committed, never for a deletion that failed to happen — proven
   * here with a fully mocked `AuthService` (no real database at all), by
   * forcing `$transaction` to reject and asserting the success audit event
   * is never written.
   */
  describe('account_deletion_success emission timing (mocked, no real database)', () => {
    it('never emits account_deletion_success when the transaction throws', async () => {
      const userId = 'mock-user-id';
      const emit = jest.fn().mockResolvedValue(undefined);
      const passwordHash = await bcrypt.hash('correct-horse-battery', 4);
      const mockPrisma = {
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: userId,
            passwordHash,
            role: 'user',
          }),
        },
        $transaction: jest
          .fn()
          .mockRejectedValue(new Error('simulated DB failure')),
      };
      const mockAuthAuditService = { emit };

      const mockedService = new AuthService(
        mockPrisma as unknown as PrismaService,
        {} as unknown as JwtService,
        { get: jest.fn() } as unknown as ConfigService<RootConfig>,
        {} as unknown as AccountLockoutService,
        mockAuthAuditService as unknown as AuthAuditService,
      );

      await expect(
        mockedService.deleteAccount(userId, {
          currentPassword: 'correct-horse-battery',
          confirmDeletion: true,
        }),
      ).rejects.toThrow('simulated DB failure');

      expect(emit).not.toHaveBeenCalledWith(
        'account_deletion_success',
        expect.anything(),
      );
    });
  });
});
