import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { HttpStatus } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import type { Session } from '@prisma/client';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { AccountLockoutService } from './account-lockout.service';
import { AuthAuditService } from './auth-audit.service';
import { MAX_USER_AGENT_LENGTH } from './auth-crypto';
import { AuthService } from './auth.service';
import type { AuthResponseDto } from './auth.types';

const TEST_AUTH_CONFIG = {
  jwtAccessSecret: 'test-access-secret-not-a-real-secret',
  jwtRefreshSecret: 'test-refresh-secret-not-a-real-secret',
  // Phase 12, work unit 12A-B3: deliberately a DIFFERENT dummy value from
  // the two secrets above, matching the real dedicated-secret requirement
  // (DECISIONS.md "Phase 12 ... approved..." entry, decision 6).
  authAuditIpHashSecret: 'test-auth-audit-ip-hash-secret-not-a-real-secret',
};

// Phase 12, work unit 12B-B2 (fix cycle 1): mirrors
// `auth-audit.service.spec.ts`'s own `OTHER_SECRET` constant, used below to
// prove `Session.ipHash` is a keyed HMAC (not a plain/unkeyed hash) — the
// same IP must hash differently under a different secret.
const OTHER_SECRET = 'a-completely-different-test-secret-not-a-real-secret';

/**
 * Integration-style spec (Phase 8, work unit 8-B5), following the same
 * pattern as the 8-B2/8-B3/8-B4 model specs: real `PrismaService` against the
 * project's dev SQLite database, self-cleaning via `afterEach` so it leaves
 * no residue, and a stubbed `ConfigService` (matching `videos.service.spec.ts`)
 * so the test controls the JWT secrets without touching real `.env` values.
 */
describe('AuthService', () => {
  let service: AuthService;
  let prisma: PrismaService;
  let jwtService: JwtService;

  const emailPrefix = 'auth-service-spec+8b5';

  const uniqueEmail = (label: string): string =>
    `${emailPrefix}-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  // Fix cycle 3 (Phase 12, 12B-B1), advisory-polish item 2: the two
  // probabilistic race tests below (real bcrypt, real concurrent Promise
  // races, no mocked timing) each ran a single iteration, so a reintroduced
  // regression had only a partial chance of being caught by any one run.
  // Looping a bounded number of times raises that catch rate without
  // changing what either test asserts. Kept small because each iteration
  // does several real cost-factor-12 bcrypt calls (~300-600ms apiece).
  const RACE_TEST_ITERATIONS = 10;

  // Fix cycle 1 (Phase 12, 12B-B3), finding 3 re-verification: the review
  // explicitly asked for >= 25 warm concurrent iterations for THIS specific
  // lock-ordering shape (single claim-and-invalidate-others statement),
  // stronger than `RACE_TEST_ITERATIONS` above (used for 12B-B1's
  // change-password races). Kept as its own constant rather than raising
  // `RACE_TEST_ITERATIONS` itself, since that would also slow down the
  // unrelated change-password race tests above for no reason.
  const PASSWORD_RESET_RACE_TEST_ITERATIONS = 25;

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
    jwtService = module.get<JwtService>(JwtService);
    await prisma.onModuleInit();
  });

  afterEach(async () => {
    // `AccountLockout`/`Session` both cascade-delete with their `User`
    // (Phase 12 additive migration, `onDelete: Cascade`), but this is
    // explicit rather than relying on that alone, matching the existing
    // `session.deleteMany` line's own precedent below. `AuthAuditEvent`
    // instead `SetNull`s on user deletion (Phase 12, work unit 12A-B3 — see
    // its schema doc comment), so it is cleaned up explicitly here too,
    // BEFORE the user row is deleted, while `userId` still links each row
    // back to this test's own prefixed accounts.
    await prisma.authAuditEvent.deleteMany({
      where: { user: { email: { contains: emailPrefix } } },
    });
    // Orphaned rows with no linked user (e.g. a login attempt for an email
    // that never resolved to any account) — see the "nonexistent email"
    // login test above for the one call site that creates one.
    await prisma.authAuditEvent.deleteMany({
      where: { userId: null, userAgent: { contains: emailPrefix } },
    });
    await prisma.accountLockout.deleteMany({
      where: { user: { email: { contains: emailPrefix } } },
    });
    await prisma.session.deleteMany({
      where: { user: { email: { contains: emailPrefix } } },
    });
    await prisma.user.deleteMany({
      where: { email: { contains: emailPrefix } },
    });
    await prisma.onModuleDestroy();
  });

  describe('register', () => {
    it('creates a user, hashes the password, and returns a token pair with a persisted session', async () => {
      const email = uniqueEmail('register-success');

      const result = await service.register({
        email,
        password: 'correct-horse-battery',
        displayName: 'New User',
      });

      expect(result.user.email).toBe(email);
      expect(result.user.displayName).toBe('New User');
      expect(result.accessToken).toEqual(expect.any(String));
      expect(result.refreshToken).toEqual(expect.any(String));

      const storedUser = await prisma.user.findUnique({ where: { email } });
      expect(storedUser).not.toBeNull();
      expect(storedUser?.passwordHash).not.toBe('correct-horse-battery');

      const sessions = await prisma.session.findMany({
        where: { userId: storedUser!.id },
      });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].refreshTokenHash).not.toBe(result.refreshToken);
      expect(sessions[0].revokedAt).toBeNull();

      const decoded = jwtService.decode<{ sub: string }>(result.accessToken);
      expect(decoded.sub).toBe(storedUser!.id);
    });

    /**
     * Phase 12, work unit 12A-B3: proves `AuthService.register` is actually
     * wired to `AuthAuditService.emit`, not just unit-tested in isolation
     * (see `auth-audit.service.spec.ts` for `emit`'s own hashing/
     * sanitization coverage). Also proves the raw IP passed in never reaches
     * the stored row as-is — only its HMAC hash does.
     */
    it('writes a register_success AuthAuditEvent row with a hashed (never raw) IP and no raw email in metadata', async () => {
      const email = uniqueEmail('register-audit');
      const rawIp = '203.0.113.42';

      const result = await service.register(
        { email, password: 'correct-horse-battery' },
        { ip: rawIp, userAgent: 'audit-spec-test-agent/1.0' },
      );

      const auditRows = await prisma.authAuditEvent.findMany({
        where: { userId: result.user.id },
      });

      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].event).toBe('register_success');
      expect(auditRows[0].ipHash).not.toBeNull();
      expect(auditRows[0].ipHash).not.toBe(rawIp);
      expect(auditRows[0].userAgent).toBe('audit-spec-test-agent/1.0');
      expect(JSON.stringify(auditRows[0])).not.toContain(email);
      expect(JSON.stringify(auditRows[0])).not.toContain(rawIp);
    });

    it('rejects registration with a duplicate email using a structured conflict error', async () => {
      const email = uniqueEmail('register-duplicate');
      await service.register({ email, password: 'correct-horse-battery' });

      await expect(
        service.register({ email, password: 'another-password-1' }),
      ).rejects.toMatchObject({
        code: AppErrorCode.EMAIL_ALREADY_REGISTERED,
        status: HttpStatus.CONFLICT,
      } as Partial<AppException>);
    });

    it('rejects registration with a case-variant of an already-registered email', async () => {
      const email = uniqueEmail('register-case-duplicate');
      await service.register({ email, password: 'correct-horse-battery' });

      const shoutedVariant = email.toUpperCase();

      await expect(
        service.register({
          email: shoutedVariant,
          password: 'another-password-1',
        }),
      ).rejects.toMatchObject({
        code: AppErrorCode.EMAIL_ALREADY_REGISTERED,
        status: HttpStatus.CONFLICT,
      } as Partial<AppException>);
    });

    it('normalizes the stored email to lowercase regardless of the casing supplied at registration', async () => {
      const email = uniqueEmail('register-normalizes');
      const mixedCaseEmail = email
        .split('')
        .map((char, index) => (index % 2 === 0 ? char.toUpperCase() : char))
        .join('');

      const result = await service.register({
        email: mixedCaseEmail,
        password: 'correct-horse-battery',
      });

      expect(result.user.email).toBe(email);

      const storedUser = await prisma.user.findUnique({ where: { email } });
      expect(storedUser).not.toBeNull();
    });
  });

  describe('login', () => {
    it('logs in successfully with the correct password', async () => {
      const email = uniqueEmail('login-success');
      await service.register({ email, password: 'correct-horse-battery' });

      const result = await service.login({
        email,
        password: 'correct-horse-battery',
      });

      expect(result.user.email).toBe(email);
      expect(result.accessToken).toEqual(expect.any(String));
      expect(result.refreshToken).toEqual(expect.any(String));
    });

    it('rejects a wrong password with a generic invalid-credentials error', async () => {
      const email = uniqueEmail('login-wrong-password');
      await service.register({ email, password: 'correct-horse-battery' });

      await expect(
        service.login({ email, password: 'totally-wrong-password' }),
      ).rejects.toMatchObject({
        code: AppErrorCode.INVALID_CREDENTIALS,
        status: HttpStatus.UNAUTHORIZED,
      } as Partial<AppException>);
    });

    /**
     * Phase 12, work unit 12A-B3: `login_success`/`login_failed`
     * AuthAuditEvent rows are actually written from the real
     * `AuthService.login` call sites (not merely unit-tested on
     * `AuthAuditService` in isolation) and carry none of the sensitive
     * values DECISIONS.md decision 6 / the "Additional binding
     * requirements" section forbid (raw email, raw password, raw IP,
     * token).
     */
    it('writes login_success / login_failed AuthAuditEvent rows containing no email/password/token/raw-IP', async () => {
      const email = uniqueEmail('login-audit');
      const registered = await service.register({
        email,
        password: 'correct-horse-battery',
      });

      await expect(
        service.login(
          { email, password: 'totally-wrong-password' },
          { ip: '198.51.100.7', userAgent: 'audit-spec-login-agent' },
        ),
      ).rejects.toBeInstanceOf(AppException);

      await service.login(
        { email, password: 'correct-horse-battery' },
        { ip: '198.51.100.7', userAgent: 'audit-spec-login-agent' },
      );

      const auditRows = await prisma.authAuditEvent.findMany({
        where: { userId: registered.user.id },
        orderBy: { createdAt: 'asc' },
      });

      // register_success (from the earlier `service.register` call above,
      // with no `ip`/`userAgent` supplied) + login_failed + login_success.
      expect(auditRows.map((row) => row.event)).toEqual([
        'register_success',
        'login_failed',
        'login_success',
      ]);

      const loginFailedRow = auditRows[1];
      expect(loginFailedRow.metadata).toEqual({ reason: 'invalid_password' });
      expect(loginFailedRow.ipHash).not.toBeNull();
      expect(loginFailedRow.ipHash).not.toBe('198.51.100.7');

      const loginSuccessRow = auditRows[2];
      expect(loginSuccessRow.userAgent).toBe('audit-spec-login-agent');

      const serialized = JSON.stringify(auditRows);
      expect(serialized).not.toContain(email);
      expect(serialized).not.toContain('correct-horse-battery');
      expect(serialized).not.toContain('totally-wrong-password');
      expect(serialized).not.toContain('198.51.100.7');
      expect(serialized).not.toContain(registered.refreshToken);
    });

    it('logs in successfully when the casing of the email differs from registration', async () => {
      const email = uniqueEmail('login-case-insensitive');
      await service.register({ email, password: 'correct-horse-battery' });

      const result = await service.login({
        email: email.toUpperCase(),
        password: 'correct-horse-battery',
      });

      expect(result.user.email).toBe(email);
      expect(result.accessToken).toEqual(expect.any(String));
      expect(result.refreshToken).toEqual(expect.any(String));
    });

    it('rejects a nonexistent email with the SAME error shape as a wrong password (no user enumeration)', async () => {
      const wrongPasswordEmail = uniqueEmail('login-shape-existing');
      await service.register({
        email: wrongPasswordEmail,
        password: 'correct-horse-battery',
      });

      let wrongPasswordError: unknown;
      try {
        await service.login({
          email: wrongPasswordEmail,
          password: 'totally-wrong-password',
        });
      } catch (error) {
        wrongPasswordError = error;
      }

      let nonexistentEmailError: unknown;
      try {
        await service.login(
          {
            email: uniqueEmail('login-shape-nonexistent'),
            password: 'totally-wrong-password',
          },
          // Phase 12, work unit 12A-B3: this is the one call site in this
          // spec file that emits a `userId: null` AuthAuditEvent row (no
          // user ever resolved) — a distinctive `userAgent` marker lets
          // `afterEach` clean it up below, since it cannot be found via the
          // usual `user: { email: { contains: emailPrefix } }` relation
          // filter (there is no related user to filter through).
          { userAgent: `${emailPrefix}-nonexistent-email-audit-marker` },
        );
      } catch (error) {
        nonexistentEmailError = error;
      }

      expect(wrongPasswordError).toBeInstanceOf(AppException);
      expect(nonexistentEmailError).toBeInstanceOf(AppException);
      expect((nonexistentEmailError as AppException).code).toBe(
        (wrongPasswordError as AppException).code,
      );
      expect((nonexistentEmailError as AppException).getStatus()).toBe(
        (wrongPasswordError as AppException).getStatus(),
      );
      expect((nonexistentEmailError as AppException).message).toBe(
        (wrongPasswordError as AppException).message,
      );
    });

    /**
     * Phase 12, work unit 12A-B1: persistent account lockout, exercised
     * through the real `AuthService.login` path (not just
     * `AccountLockoutService` in isolation — see `account-lockout.service.spec.ts`
     * for the lockout-logic-only coverage of increments/threshold/window/
     * reset). This proves the two are actually wired together correctly.
     */
    it('locks the account after 10 failed logins and rejects a SUBSEQUENT CORRECT password with the identical generic error while locked', async () => {
      const email = uniqueEmail('login-lockout');
      const correctPassword = 'correct-horse-battery';
      await service.register({ email, password: correctPassword });

      let wrongPasswordError: unknown;
      for (let i = 0; i < 10; i += 1) {
        try {
          await service.login({ email, password: 'totally-wrong-password' });
        } catch (error) {
          wrongPasswordError = error;
        }
      }

      // The 10th failure should have locked the account — even the
      // genuinely correct password is now rejected.
      let lockedCorrectPasswordError: unknown;
      try {
        await service.login({ email, password: correctPassword });
      } catch (error) {
        lockedCorrectPasswordError = error;
      }

      expect(lockedCorrectPasswordError).toBeInstanceOf(AppException);
      expect(wrongPasswordError).toBeInstanceOf(AppException);
      expect((lockedCorrectPasswordError as AppException).code).toBe(
        (wrongPasswordError as AppException).code,
      );
      expect((lockedCorrectPasswordError as AppException).message).toBe(
        (wrongPasswordError as AppException).message,
      );
      expect((lockedCorrectPasswordError as AppException).code).toBe(
        AppErrorCode.INVALID_CREDENTIALS,
      );

      const lockout = await prisma.accountLockout.findFirst({
        where: { user: { email } },
      });
      expect(lockout?.lockedUntil).not.toBeNull();

      // Phase 12, work unit 12A-B3: the locked-account attempt above must
      // have written its own `account_locked` row, distinct from the 10
      // preceding `login_failed` rows.
      const auditEvents = await prisma.authAuditEvent.findMany({
        where: { user: { email } },
        orderBy: { createdAt: 'asc' },
      });
      expect(auditEvents).toHaveLength(12); // register_success + 10 login_failed + 1 account_locked
      expect(auditEvents[0].event).toBe('register_success');
      expect(
        auditEvents.slice(1, 11).every((row) => row.event === 'login_failed'),
      ).toBe(true);
      expect(auditEvents[11].event).toBe('account_locked');
    });

    it('allows login again once the lock window has elapsed (simulated via the stored timestamp)', async () => {
      const email = uniqueEmail('login-lockout-expired');
      const correctPassword = 'correct-horse-battery';
      const registered = await service.register({
        email,
        password: correctPassword,
      });

      await prisma.accountLockout.create({
        data: {
          userId: registered.user.id,
          failedCount: 10,
          windowStartedAt: new Date(Date.now() - 20 * 60 * 1000),
          lockedUntil: new Date(Date.now() - 1000), // already elapsed
        },
      });

      const result = await service.login({ email, password: correctPassword });
      expect(result.user.email).toBe(email);

      const lockout = await prisma.accountLockout.findFirst({
        where: { user: { email } },
      });
      expect(lockout?.failedCount).toBe(0);
      expect(lockout?.lockedUntil).toBeNull();
    });

    it('a successful login resets the failure count so it does not carry over toward a future lock', async () => {
      const email = uniqueEmail('login-reset-on-success');
      const correctPassword = 'correct-horse-battery';
      await service.register({ email, password: correctPassword });

      for (let i = 0; i < 9; i += 1) {
        await expect(
          service.login({ email, password: 'totally-wrong-password' }),
        ).rejects.toBeInstanceOf(AppException);
      }

      // The 10th attempt succeeds and must reset the counter — otherwise a
      // 10th call here would already be the lockout-triggering failure.
      await service.login({ email, password: correctPassword });

      const lockout = await prisma.accountLockout.findFirst({
        where: { user: { email } },
      });
      expect(lockout?.failedCount).toBe(0);
      expect(lockout?.lockedUntil).toBeNull();
    });
  });

  describe('refresh', () => {
    it('issues a new token pair and rotates (revokes) the old session', async () => {
      const email = uniqueEmail('refresh-success');
      const registered = await service.register({
        email,
        password: 'correct-horse-battery',
      });

      const oldSessions = await prisma.session.findMany({
        where: { user: { email } },
      });
      expect(oldSessions).toHaveLength(1);
      const oldSessionId = oldSessions[0].id;

      const refreshed = await service.refresh(registered.refreshToken);

      expect(refreshed.accessToken).toEqual(expect.any(String));
      expect(refreshed.refreshToken).not.toBe(registered.refreshToken);

      const oldSessionAfter = await prisma.session.findUnique({
        where: { id: oldSessionId },
      });
      expect(oldSessionAfter?.revokedAt).not.toBeNull();

      const allSessions = await prisma.session.findMany({
        where: { user: { email } },
      });
      expect(allSessions).toHaveLength(2);
    });

    it('rejects an unknown/garbage refresh token', async () => {
      await expect(
        service.refresh('this-token-was-never-issued'),
      ).rejects.toMatchObject({
        code: AppErrorCode.INVALID_REFRESH_TOKEN,
        status: HttpStatus.UNAUTHORIZED,
      } as Partial<AppException>);
    });

    it('rejects an expired refresh token', async () => {
      // We can't easily produce a real plaintext token matching a
      // hand-seeded hash (the hash is HMAC-keyed with a server secret), so
      // instead we register normally, force that session to look expired,
      // and refresh with its real plaintext token to hit the expiry branch
      // honestly.
      const registered = await service.register({
        email: uniqueEmail('refresh-expired-real'),
        password: 'correct-horse-battery',
      });
      const realSession = await prisma.session.findFirst({
        where: { user: { email: registered.user.email } },
      });
      await prisma.session.update({
        where: { id: realSession!.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await expect(
        service.refresh(registered.refreshToken),
      ).rejects.toMatchObject({
        code: AppErrorCode.INVALID_REFRESH_TOKEN,
        status: HttpStatus.UNAUTHORIZED,
      } as Partial<AppException>);
    });

    it('rejects reuse of an already-rotated refresh token and revokes the user other sessions', async () => {
      const email = uniqueEmail('refresh-reuse');
      const registered = await service.register({
        email,
        password: 'correct-horse-battery',
      });

      const firstRefresh = await service.refresh(registered.refreshToken);

      // Reusing the now-revoked original refresh token must fail.
      await expect(
        service.refresh(registered.refreshToken),
      ).rejects.toMatchObject({
        code: AppErrorCode.INVALID_REFRESH_TOKEN,
        status: HttpStatus.UNAUTHORIZED,
      } as Partial<AppException>);

      // The reuse-detection defensive measure should have revoked the
      // session created by the legitimate first refresh too.
      const sessions = await prisma.session.findMany({
        where: { user: { email } },
      });
      expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);

      await expect(
        service.refresh(firstRefresh.refreshToken),
      ).rejects.toMatchObject({
        code: AppErrorCode.INVALID_REFRESH_TOKEN,
        status: HttpStatus.UNAUTHORIZED,
      } as Partial<AppException>);

      // Phase 12, work unit 12A-B3: both reuse attempts above must have
      // written a `refresh_reuse_detected` AuthAuditEvent row (the existing
      // replay-detection/revoke-all behavior itself is unchanged — this
      // only asserts the audit emission actually fires from that path).
      const auditEvents = await prisma.authAuditEvent.findMany({
        where: { user: { email }, event: 'refresh_reuse_detected' },
      });
      expect(auditEvents).toHaveLength(2);
      expect(
        auditEvents.every(
          (row) =>
            (row.metadata as { reason?: string } | null)?.reason ===
            'already_rotated',
        ),
      ).toBe(true);
    });

    it('treats a concurrent rotation of the same session as reuse/theft instead of issuing two valid token pairs', async () => {
      // A fully concurrent DB-level race (two truly simultaneous
      // `service.refresh()` calls racing against real SQLite I/O) is
      // inherently timing-dependent and would make this test flaky in CI.
      // Instead, we deterministically simulate the exact interleaving the
      // race window in `refresh()` is vulnerable to: the application reads
      // the session (observing `revokedAt: null`), but by the time it
      // performs the conditional revoke, another request has *already*
      // revoked the same row. We do this by intercepting the first
      // `session.findUnique` call: it revokes the session directly (as a
      // stand-in for a concurrent winning request) and then still hands the
      // stale (pre-revocation) snapshot back to the service, exactly as a
      // real race would produce.
      const email = uniqueEmail('refresh-race-simulated');
      const registered = await service.register({
        email,
        password: 'correct-horse-battery',
      });

      const realSessionBeforeRefresh = await prisma.session.findFirst({
        where: { user: { email } },
      });

      const findUniqueSpy = jest
        .spyOn(prisma.session, 'findUnique')
        .mockImplementationOnce(async (): Promise<Session | null> => {
          if (realSessionBeforeRefresh) {
            await prisma.session.updateMany({
              where: { id: realSessionBeforeRefresh.id },
              data: { revokedAt: new Date() },
            });
          }
          return realSessionBeforeRefresh;
        });

      await expect(
        service.refresh(registered.refreshToken),
      ).rejects.toMatchObject({
        code: AppErrorCode.INVALID_REFRESH_TOKEN,
        status: HttpStatus.UNAUTHORIZED,
      } as Partial<AppException>);

      findUniqueSpy.mockRestore();

      // No new session should have been created for the loser of the race,
      // and the reuse/theft response should have revoked every session for
      // this user (there is only the original one here).
      const sessions = await prisma.session.findMany({
        where: { user: { email } },
      });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].revokedAt).not.toBeNull();

      // Phase 12, work unit 12A-B3: this is the OTHER branch that emits
      // `refresh_reuse_detected` (the `count === 0` concurrent-race branch,
      // distinct from the `isReuseOfRevokedToken` branch covered above) —
      // `reason` distinguishes the two in the audit log.
      const auditEvents = await prisma.authAuditEvent.findMany({
        where: { user: { email }, event: 'refresh_reuse_detected' },
      });
      expect(auditEvents).toHaveLength(1);
      expect(
        (auditEvents[0].metadata as { reason?: string } | null)?.reason,
      ).toBe('concurrent_rotation_race');
    });
  });

  describe('logout', () => {
    it('revokes the session so a subsequent refresh fails', async () => {
      const email = uniqueEmail('logout-then-refresh');
      const registered = await service.register({
        email,
        password: 'correct-horse-battery',
      });

      await service.logout(registered.refreshToken);

      await expect(
        service.refresh(registered.refreshToken),
      ).rejects.toMatchObject({
        code: AppErrorCode.INVALID_REFRESH_TOKEN,
        status: HttpStatus.UNAUTHORIZED,
      } as Partial<AppException>);
    });

    it('is silent/idempotent for an unknown refresh token', async () => {
      await expect(
        service.logout('some-token-that-does-not-exist'),
      ).resolves.toBeUndefined();
    });
  });

  /**
   * Phase 12, work unit 12B-B1: `POST /auth/change-password` (DECISIONS.md
   * "Phase 12 ... approved..." entry, decision 7). See
   * `AuthService.changePassword`'s doc comment for the full design.
   */
  describe('changePassword', () => {
    it('changes the password, revokes every OTHER session, rotates the current session token pair, and the new tokens work', async () => {
      const email = uniqueEmail('change-password-success');
      const oldPassword = 'correct-horse-battery';
      const newPassword = 'brand-new-password-1';

      const registered = await service.register({
        email,
        password: oldPassword,
      });
      // A "second device" — logging in again creates an independent session
      // that must ALSO be revoked (every OTHER session, not just one). Its
      // token is never read again; only the side effect (a second `Session`
      // row) matters for this test.
      await service.login({ email, password: oldPassword });

      const result = await service.changePassword(registered.user.id, {
        currentPassword: oldPassword,
        newPassword,
        refreshToken: registered.refreshToken,
      });

      expect(result.user.email).toBe(email);
      expect(result.accessToken).toEqual(expect.any(String));
      expect(result.refreshToken).toEqual(expect.any(String));
      expect(result.refreshToken).not.toBe(registered.refreshToken);
      // No session record, refreshTokenHash, or any hash/secret ever appears
      // in the response.
      expect(JSON.stringify(result)).not.toMatch(
        /passwordHash|refreshTokenHash|revokedAt|\$2[aby]\$/,
      );

      // Every session for this account except the brand-new one is revoked
      // — checked directly against the DB, NOT by calling `refresh()` with
      // an already-revoked token, since doing so has its OWN side effect
      // (replay-detection's defensive revoke-EVERYTHING, including the
      // brand-new session) that would contaminate this exact assertion —
      // see the dedicated "replay" test below for that behavior in
      // isolation.
      const allSessions = await prisma.session.findMany({
        where: { user: { email } },
      });
      expect(allSessions.filter((s) => s.revokedAt === null)).toHaveLength(1);
      expect(
        allSessions.filter((s) => s.revokedAt !== null).length,
      ).toBeGreaterThanOrEqual(2); // the pre-change session + the second device's session

      // The NEW token pair issued BY changePassword itself keeps working —
      // this is the "current session" being rotated, not merely killed.
      const rotatedAgain = await service.refresh(result.refreshToken);
      expect(rotatedAgain.accessToken).toEqual(expect.any(String));

      // The stored password hash actually changed.
      const storedUser = await prisma.user.findUnique({ where: { email } });
      expect(await bcrypt.compare(newPassword, storedUser!.passwordHash)).toBe(
        true,
      );
      expect(await bcrypt.compare(oldPassword, storedUser!.passwordHash)).toBe(
        false,
      );

      // Logging in with the OLD password now fails; the NEW password works.
      await expect(
        service.login({ email, password: oldPassword }),
      ).rejects.toMatchObject({
        code: AppErrorCode.INVALID_CREDENTIALS,
      });
      const loginWithNewPassword = await service.login({
        email,
        password: newPassword,
      });
      expect(loginWithNewPassword.user.email).toBe(email);

      const auditRows = await prisma.authAuditEvent.findMany({
        where: { userId: registered.user.id, event: 'change_password_success' },
      });
      expect(auditRows).toHaveLength(1);
    });

    it('rejects a wrong current password with the generic INVALID_CREDENTIALS error, leaves the password/session unchanged, and emits change_password_failed', async () => {
      const email = uniqueEmail('change-password-wrong-current');
      const correctPassword = 'correct-horse-battery';
      const registered = await service.register({
        email,
        password: correctPassword,
      });

      await expect(
        service.changePassword(registered.user.id, {
          currentPassword: 'totally-wrong-password',
          newPassword: 'brand-new-password-1',
          refreshToken: registered.refreshToken,
        }),
      ).rejects.toMatchObject({
        code: AppErrorCode.INVALID_CREDENTIALS,
        status: HttpStatus.UNAUTHORIZED,
      } as Partial<AppException>);

      const storedUser = await prisma.user.findUnique({ where: { email } });
      expect(
        await bcrypt.compare(correctPassword, storedUser!.passwordHash),
      ).toBe(true);

      // The session is untouched — the presented refresh token still works.
      const stillWorks = await service.refresh(registered.refreshToken);
      expect(stillWorks.accessToken).toEqual(expect.any(String));

      const auditRows = await prisma.authAuditEvent.findMany({
        where: { userId: registered.user.id, event: 'change_password_failed' },
      });
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].metadata).toEqual({
        reason: 'invalid_current_password',
      });
    });

    it('rejects an unknown refresh token with the generic INVALID_REFRESH_TOKEN error and makes no changes', async () => {
      const email = uniqueEmail('change-password-unknown-token');
      const correctPassword = 'correct-horse-battery';
      const registered = await service.register({
        email,
        password: correctPassword,
      });

      await expect(
        service.changePassword(registered.user.id, {
          currentPassword: correctPassword,
          newPassword: 'brand-new-password-1',
          refreshToken: 'this-token-was-never-issued',
        }),
      ).rejects.toMatchObject({
        code: AppErrorCode.INVALID_REFRESH_TOKEN,
        status: HttpStatus.UNAUTHORIZED,
      } as Partial<AppException>);

      const storedUser = await prisma.user.findUnique({ where: { email } });
      expect(
        await bcrypt.compare(correctPassword, storedUser!.passwordHash),
      ).toBe(true);
    });

    /**
     * IDOR-safety: a refresh token that hash-resolves to a real `Session`
     * row belonging to a DIFFERENT account must never be usable as "the
     * current session" for this caller — this must be impossible, not
     * merely unlikely.
     */
    it('rejects a refresh token belonging to a DIFFERENT account (cross-account attempt) and leaves both accounts unchanged', async () => {
      const emailA = uniqueEmail('change-password-cross-account-a');
      const emailB = uniqueEmail('change-password-cross-account-b');
      const correctPassword = 'correct-horse-battery';
      const userA = await service.register({
        email: emailA,
        password: correctPassword,
      });
      const userB = await service.register({
        email: emailB,
        password: correctPassword,
      });

      await expect(
        service.changePassword(userA.user.id, {
          currentPassword: correctPassword,
          newPassword: 'brand-new-password-1',
          refreshToken: userB.refreshToken,
        }),
      ).rejects.toMatchObject({
        code: AppErrorCode.INVALID_REFRESH_TOKEN,
        status: HttpStatus.UNAUTHORIZED,
      } as Partial<AppException>);

      const storedUserA = await prisma.user.findUnique({
        where: { email: emailA },
      });
      expect(
        await bcrypt.compare(correctPassword, storedUserA!.passwordHash),
      ).toBe(true);

      const sessionsB = await prisma.session.findMany({
        where: { user: { email: emailB } },
      });
      expect(sessionsB.every((s) => s.revokedAt === null)).toBe(true);
    });

    /**
     * Preserves `refresh()`'s existing replay-detection unchanged: since
     * change-password REVOKES (not deletes) the pre-change session, reusing
     * its refresh token afterward must be caught by the SAME
     * `isReuseOfRevokedToken` branch a normal `refresh()` rotation would
     * trigger.
     */
    it('after rotation, reusing the OLD (pre-change-password) refresh token is detected as replay and revokes every session', async () => {
      const email = uniqueEmail('change-password-replay');
      const correctPassword = 'correct-horse-battery';
      const registered = await service.register({
        email,
        password: correctPassword,
      });

      const result = await service.changePassword(registered.user.id, {
        currentPassword: correctPassword,
        newPassword: 'brand-new-password-1',
        refreshToken: registered.refreshToken,
      });

      await expect(
        service.refresh(registered.refreshToken),
      ).rejects.toMatchObject({
        code: AppErrorCode.INVALID_REFRESH_TOKEN,
        status: HttpStatus.UNAUTHORIZED,
      } as Partial<AppException>);

      const sessions = await prisma.session.findMany({
        where: { user: { email } },
      });
      expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);

      const reuseEvents = await prisma.authAuditEvent.findMany({
        where: { user: { email }, event: 'refresh_reuse_detected' },
      });
      expect(
        reuseEvents.some(
          (row) =>
            (row.metadata as { reason?: string } | null)?.reason ===
            'already_rotated',
        ),
      ).toBe(true);

      // The replay's defensive revoke-all also kills the legitimately
      // rotated NEW session — reusing a stolen old token must cut off the
      // whole chain, including the one change-password itself just issued.
      await expect(service.refresh(result.refreshToken)).rejects.toMatchObject({
        code: AppErrorCode.INVALID_REFRESH_TOKEN,
        status: HttpStatus.UNAUTHORIZED,
      } as Partial<AppException>);
    });

    /**
     * Simulates the exact interleaving `refresh()`'s own race test does
     * (see "treats a concurrent rotation of the same session as reuse/theft"
     * above): the application reads the current session (`revokedAt: null`),
     * but by the time it performs the conditional revoke, another request
     * has ALREADY revoked the same row.
     */
    it('treats a concurrent rotation of the current session as reuse/theft instead of applying the password change', async () => {
      const email = uniqueEmail('change-password-race-simulated');
      const correctPassword = 'correct-horse-battery';
      const registered = await service.register({
        email,
        password: correctPassword,
      });

      const realSessionBeforeChange = await prisma.session.findFirst({
        where: { user: { email } },
      });

      // `mockImplementationOnce`'s parameter type is Prisma's generated
      // `Prisma__SessionClient` fluent-thenable (it also exposes relation
      // methods like `.user()`), which a plain `Promise<Session | null>`
      // does not structurally satisfy. Cast the implementation to the exact
      // spied method's own type — a plain resolved Promise is a valid
      // thenable at runtime (all real call sites here just `await` it),
      // this cast only tells the type checker to trust that.
      const findUniqueSpy = jest
        .spyOn(prisma.session, 'findUnique')
        .mockImplementationOnce((async (): Promise<Session | null> => {
          if (realSessionBeforeChange) {
            await prisma.session.updateMany({
              where: { id: realSessionBeforeChange.id },
              data: { revokedAt: new Date() },
            });
          }
          return realSessionBeforeChange;
        }) as unknown as typeof prisma.session.findUnique);

      await expect(
        service.changePassword(registered.user.id, {
          currentPassword: correctPassword,
          newPassword: 'brand-new-password-1',
          refreshToken: registered.refreshToken,
        }),
      ).rejects.toMatchObject({
        code: AppErrorCode.INVALID_REFRESH_TOKEN,
        status: HttpStatus.UNAUTHORIZED,
      } as Partial<AppException>);

      findUniqueSpy.mockRestore();

      // The password change must NOT have been applied.
      const storedUser = await prisma.user.findUnique({ where: { email } });
      expect(
        await bcrypt.compare(correctPassword, storedUser!.passwordHash),
      ).toBe(true);

      // Every session for the account ends up revoked (the defensive
      // revoke-all), and no new session was created for the loser of the
      // race.
      const sessions = await prisma.session.findMany({
        where: { user: { email } },
      });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].revokedAt).not.toBeNull();

      const auditEvents = await prisma.authAuditEvent.findMany({
        where: { user: { email }, event: 'refresh_reuse_detected' },
      });
      expect(auditEvents).toHaveLength(1);
      expect(
        (auditEvents[0].metadata as { reason?: string } | null)?.reason,
      ).toBe('concurrent_rotation_race');
    });

    /**
     * BLOCKING FINDING 1 (Phase 12, 12B-B1 fix cycle 1): reproduces the
     * scenario the reviewer found deadlocking against the REAL code (not a
     * reimplementation) — an account with TWO different, genuinely
     * concurrent, currently-active sessions (e.g. phone + tablet) both
     * calling `changePassword` at once via `Promise.allSettled`, with no
     * artificial delay. Before the fix, the transaction's separate
     * CAS-on-current-session + broad-revoke-every-OTHER-session statements
     * let the two transactions lock rows in opposite orders and deadlock
     * (Postgres `40P01`), which surfaced as an unhandled
     * `PrismaClientUnknownRequestError` (an opaque 500) instead of the
     * documented clean race path. This test uses two REAL sessions and REAL
     * concurrency (not the deterministic single-shared-token mock above),
     * matching exactly what the reviewer reproduced.
     */
    it('two concurrent change-password calls for two DIFFERENT active sessions of the same account do not deadlock — one succeeds, the other fails cleanly through the documented race path', async () => {
      for (let iteration = 0; iteration < RACE_TEST_ITERATIONS; iteration++) {
        const email = uniqueEmail(
          `change-password-two-session-race-${iteration}`,
        );
        const correctPassword = 'correct-horse-battery';
        const registered = await service.register({
          email,
          password: correctPassword,
        });
        // A genuinely independent SECOND active session for the SAME account
        // (a real `login`, not a mock) — this is precisely the "phone +
        // tablet" scenario decision 7's "revoke every OTHER session" exists
        // to serve.
        const secondDevice = await service.login({
          email,
          password: correctPassword,
        });

        const [resultA, resultB] = await Promise.allSettled([
          service.changePassword(registered.user.id, {
            currentPassword: correctPassword,
            newPassword: 'brand-new-password-from-device-a',
            refreshToken: registered.refreshToken,
          }),
          service.changePassword(registered.user.id, {
            currentPassword: correctPassword,
            newPassword: 'brand-new-password-from-device-b',
            refreshToken: secondDevice.refreshToken,
          }),
        ]);
        const settled = [resultA, resultB];

        // Neither settlement may be an unhandled/opaque failure. The deadlock
        // bug this test guards against surfaces as a raw
        // `PrismaClientUnknownRequestError` (Postgres `40P01`), never a clean
        // `AppException` — so any rejection here must carry the documented
        // `INVALID_REFRESH_TOKEN` shape, never anything else.
        for (const result of settled) {
          if (result.status === 'rejected') {
            expect(result.reason).toBeInstanceOf(AppException);
            expect((result.reason as AppException).code).toBe(
              AppErrorCode.INVALID_REFRESH_TOKEN,
            );
          }
        }

        // Exactly one call wins (password changed, fresh token pair) and
        // exactly one loses (rejected via the existing
        // concurrent-rotation-race path) — never both succeeding (race-safety
        // bypassed) and never both failing (account stuck, unable to change
        // its password at all).
        const fulfilled = settled.filter(
          (r): r is PromiseFulfilledResult<AuthResponseDto> =>
            r.status === 'fulfilled',
        );
        const rejected = settled.filter((r) => r.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        // The winner's brand-new token pair actually still works afterward —
        // proof the loser's defensive cleanup revoke never swept up the
        // winner's freshly created replacement session.
        const winnerResponse = fulfilled[0].value;
        const refreshedAgain = await service.refresh(
          winnerResponse.refreshToken,
        );
        expect(refreshedAgain.accessToken).toEqual(expect.any(String));

        // The account is never left with zero active sessions.
        const activeSessions = await prisma.session.findMany({
          where: { user: { email }, revokedAt: null },
        });
        expect(activeSessions).toHaveLength(1);

        // The loser's rejection used the SAME existing
        // `refresh_reuse_detected` / `concurrent_rotation_race` audit path —
        // no new error code or event type was invented for this fix.
        const auditEvents = await prisma.authAuditEvent.findMany({
          where: { user: { email }, event: 'refresh_reuse_detected' },
        });
        expect(auditEvents).toHaveLength(1);
        expect(
          (auditEvents[0].metadata as { reason?: string } | null)?.reason,
        ).toBe('concurrent_rotation_race');
      }
    }, 60000);

    /**
     * BLOCKING CRITICAL (Phase 12, 12B-B1 fix cycle 2): reproduces, against
     * the REAL code (not a reimplementation), the exact scenario the
     * reviewer found reproducible 30/30 (100%) before this fix — ANYONE who
     * still holds the CURRENT, not-yet-changed password (e.g. an attacker
     * who obtained it, or simply a second concurrent login by the account
     * owner) racing a `login()` call at the exact same moment the account
     * owner calls `changePassword()`. Fix-cycle-1's revoke-all statement was
     * bounded by `createdAt: { lte: now }`, where `now` was captured BEFORE
     * either bcrypt call inside `changePassword` (roughly 300–600ms of work
     * at `BCRYPT_COST_FACTOR = 12`) — so a session created by `login()`
     * moments later was structurally excluded from every revoke-all
     * statement and survived the password change permanently, even though
     * the account owner's whole point in changing the password was "cut off
     * every other session." This uses a REAL `login()` call racing a REAL
     * `changePassword()` call via `Promise.allSettled` (no mocks, no
     * artificial delay), matching exactly what the reviewer reproduced.
     */
    it('a login() racing changePassword() with the still-valid CURRENT password never leaves a surviving extra session', async () => {
      for (let iteration = 0; iteration < RACE_TEST_ITERATIONS; iteration++) {
        const email = uniqueEmail(`change-password-login-race-${iteration}`);
        const oldPassword = 'correct-horse-battery';
        const newPassword = 'brand-new-password-1';

        const registered = await service.register({
          email,
          password: oldPassword,
        });

        const [changePasswordResult, loginResult] = await Promise.allSettled([
          service.changePassword(registered.user.id, {
            currentPassword: oldPassword,
            newPassword,
            refreshToken: registered.refreshToken,
          }),
          service.login({ email, password: oldPassword }),
        ]);

        // `login()` never contends for the same session row `changePassword`
        // is rotating (it only ever creates a brand-new row of its own), so
        // it always succeeds independently of the race outcome — asserting
        // this keeps the test as "the exact scenario reported" rather than a
        // degenerate run where one call trivially errors for an unrelated
        // reason. `changePassword` also always wins here: nothing else in
        // this test ever touches `registered`'s own session row.
        expect(loginResult.status).toBe('fulfilled');
        expect(changePasswordResult.status).toBe('fulfilled');

        // The core of the CRITICAL finding: exactly ONE active session must
        // survive for the account afterward — the fresh session
        // `changePassword` itself issued. Before this fix, this was 2 (the
        // attacker/second-login's session structurally escaped the
        // `createdAt`-bounded revoke-all and stayed active forever).
        const activeSessions = await prisma.session.findMany({
          where: { user: { email }, revokedAt: null },
        });
        expect(activeSessions).toHaveLength(1);

        // The winner's brand-new token pair still works afterward — proof
        // this fix's revoke-all (which now has no `createdAt` bound at all)
        // did not collaterally revoke `changePassword`'s OWN replacement
        // session in the process of catching the racing login's session.
        if (changePasswordResult.status === 'fulfilled') {
          expect(activeSessions[0].id).toEqual(expect.any(String));
          const refreshedAgain = await service.refresh(
            changePasswordResult.value.refreshToken,
          );
          expect(refreshedAgain.accessToken).toEqual(expect.any(String));
        }
      }
    }, 60000);

    /**
     * BLOCKING FINDING 2 (Phase 12, 12B-B1 fix cycle 1): mirrors
     * `getUserById`'s existing precedent for this exact situation (see
     * "rejects with INVALID_ACCESS_TOKEN when the user id does not exist"
     * above) — an access token that verified fine (this method is only ever
     * reached via `JwtAuthGuard`), but whose `sub` no longer resolves to a
     * real user because the account was deleted after the token was issued.
     */
    it('rejects with INVALID_ACCESS_TOKEN when the caller user id no longer exists (e.g. deleted after token issuance)', async () => {
      const email = uniqueEmail('change-password-user-deleted');
      const correctPassword = 'correct-horse-battery';
      const registered = await service.register({
        email,
        password: correctPassword,
      });

      await prisma.session.deleteMany({
        where: { userId: registered.user.id },
      });
      await prisma.user.delete({ where: { id: registered.user.id } });

      await expect(
        service.changePassword(registered.user.id, {
          currentPassword: correctPassword,
          newPassword: 'brand-new-password-1',
          refreshToken: registered.refreshToken,
        }),
      ).rejects.toMatchObject({
        code: AppErrorCode.INVALID_ACCESS_TOKEN,
        status: HttpStatus.UNAUTHORIZED,
      } as Partial<AppException>);
    });

    /**
     * BLOCKING FINDING 3 (Phase 12, 12B-B1 fix cycle 1): adapts `refresh()`'s
     * existing "rejects an expired refresh token" precedent (see that test
     * above, which forces `expiresAt` into the past on a NOT-revoked
     * session) to `changePassword`'s `isCurrentSessionUsable` check —
     * proves the expiry half of that check (as opposed to the
     * already-covered revoked/unknown/cross-account halves) is actually
     * exercised.
     */
    it('rejects an expired-but-not-revoked current session with the generic INVALID_REFRESH_TOKEN error and makes no changes', async () => {
      const email = uniqueEmail('change-password-expired-session');
      const correctPassword = 'correct-horse-battery';
      const registered = await service.register({
        email,
        password: correctPassword,
      });

      const realSession = await prisma.session.findFirst({
        where: { user: { email } },
      });
      await prisma.session.update({
        where: { id: realSession!.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await expect(
        service.changePassword(registered.user.id, {
          currentPassword: correctPassword,
          newPassword: 'brand-new-password-1',
          refreshToken: registered.refreshToken,
        }),
      ).rejects.toMatchObject({
        code: AppErrorCode.INVALID_REFRESH_TOKEN,
        status: HttpStatus.UNAUTHORIZED,
      } as Partial<AppException>);

      // Neither the password nor the session's revocation state changed —
      // this must be indistinguishable from any other "current session not
      // usable" rejection, and must not itself revoke anything.
      const storedUser = await prisma.user.findUnique({ where: { email } });
      expect(
        await bcrypt.compare(correctPassword, storedUser!.passwordHash),
      ).toBe(true);

      const sessionAfter = await prisma.session.findUnique({
        where: { id: realSession!.id },
      });
      expect(sessionAfter?.revokedAt).toBeNull();
    });

    /**
     * Fix cycle 1 (Phase 12, 12B-B2): `changePassword`'s replacement session
     * is created via the SAME `issueTokensAndSession(user, context, tx)`
     * call site `register`/`login`/`refresh` already use (see this file's
     * "session metadata" describe block above), and passes the caller's
     * `context` through unchanged — but until now no shipped test exercised
     * THIS call site specifically. Decision 6 (DECISIONS.md "Phase 12 ...
     * approved..." entry) requires HMAC IP hashing wired everywhere a
     * `Session` is created or refreshed, which includes this one.
     */
    it("propagates the caller's context (sanitized userAgent, HMAC ipHash) onto the replacement session it creates", async () => {
      const email = uniqueEmail('change-password-context-propagation');
      const oldPassword = 'correct-horse-battery';
      const registered = await service.register({
        email,
        password: oldPassword,
      });

      const rawIp = '198.51.100.42';
      const userAgent = 'change-password-agent/1.0';

      await service.changePassword(
        registered.user.id,
        {
          currentPassword: oldPassword,
          newPassword: 'brand-new-password-1',
          refreshToken: registered.refreshToken,
        },
        { ip: rawIp, userAgent },
      );

      const replacementSession = await prisma.session.findFirst({
        where: { userId: registered.user.id, revokedAt: null },
      });

      expect(replacementSession).not.toBeNull();
      expect(replacementSession!.userAgent).toBe(userAgent);
      expect(replacementSession!.ipHash).not.toBeNull();
      expect(replacementSession!.ipHash).not.toBe(rawIp);
      // A real HMAC-SHA256 hex digest is 64 characters — proves this is
      // actually the same `hashIp` primitive, not merely "some non-null
      // value".
      expect(replacementSession!.ipHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(replacementSession)).not.toContain(rawIp);
    });
  });

  /**
   * Work unit 8-B7: closes the gap flagged (LOW, non-blocking) during 8-B6's
   * review — `getUserById` (used by `GET /auth/me`) had no direct unit
   * coverage at all, success or failure. The "user deleted after token
   * issuance" 401 path in particular had only been verified by code
   * inspection, never exercised by a test.
   */
  describe('getUserById', () => {
    it('returns the user without the password hash', async () => {
      const email = uniqueEmail('get-user-by-id');
      const registered = await service.register({
        email,
        password: 'correct-horse-battery',
        displayName: 'Lookup User',
      });

      const user = await service.getUserById(registered.user.id);

      expect(user).toEqual({
        id: registered.user.id,
        email,
        displayName: 'Lookup User',
      });
      expect(JSON.stringify(user)).not.toMatch(/passwordHash|\$2[aby]\$/);
    });

    it('rejects with INVALID_ACCESS_TOKEN when the user id does not exist (e.g. deleted after token issuance)', async () => {
      const email = uniqueEmail('get-user-by-id-deleted');
      const registered = await service.register({
        email,
        password: 'correct-horse-battery',
      });

      await prisma.session.deleteMany({
        where: { userId: registered.user.id },
      });
      await prisma.user.delete({ where: { id: registered.user.id } });

      await expect(
        service.getUserById(registered.user.id),
      ).rejects.toMatchObject({
        code: AppErrorCode.INVALID_ACCESS_TOKEN,
        status: HttpStatus.UNAUTHORIZED,
      } as Partial<AppException>);
    });
  });

  /**
   * Phase 12, work unit 12B-B2: proves the new additive `Session.userAgent`/
   * `Session.ipHash`/`Session.lastUsedAt` columns are actually populated by
   * `issueTokensAndSession` (the shared session-creation path behind
   * `register`/`login`/`refresh`/`changePassword`), using the SAME
   * `hashIp`/`sanitizeUserAgent` primitives `AuthAuditService` already uses
   * for `AuthAuditEvent` (`./auth-crypto.ts`) — never a second, divergent
   * implementation.
   */
  describe('session metadata (userAgent/ipHash/lastUsedAt)', () => {
    it('stores a hashed (never raw) IP and a sanitized user agent on the session created by register', async () => {
      const email = uniqueEmail('session-metadata-register');
      const rawIp = '198.51.100.7';
      // Contains ASCII control characters (BEL 0x07, DEL 0x7F) that
      // `sanitizeUserAgent` must strip.
      const controlCharacterLadenUserAgent = 'Mozilla/5.0(evil)';

      const result = await service.register(
        { email, password: 'correct-horse-battery' },
        { ip: rawIp, userAgent: controlCharacterLadenUserAgent },
      );

      const session = await prisma.session.findFirst({
        where: { userId: result.user.id },
      });

      expect(session).not.toBeNull();
      expect(session!.ipHash).not.toBeNull();
      expect(session!.ipHash).not.toBe(rawIp);
      // A real HMAC-SHA256 hex digest is 64 characters — mirrors
      // `auth-audit.service.spec.ts`'s identical assertion for
      // `AuthAuditEvent.ipHash` (fix cycle 1, Phase 12, 12B-B2: this was
      // previously only checked indirectly via "not the raw IP", which
      // would not catch a future accidental fork of the session-writing
      // path onto some other, non-HMAC hash).
      expect(session!.ipHash).toMatch(/^[0-9a-f]{64}$/);
      expect(session!.userAgent).toBe('Mozilla/5.0(evil)');
      expect(session!.lastUsedAt).not.toBeNull();
      expect(JSON.stringify(session)).not.toContain(rawIp);
    });

    /**
     * Fix cycle 1 (Phase 12, 12B-B2): `hashIp` is the SAME imported function
     * on both the `AuthAuditEvent` and `Session` paths, so this is not a
     * functional risk today — but nothing previously asserted
     * secret-sensitivity directly against `Session.ipHash` itself, so a
     * future accidental fork of the session-writing path onto a
     * non-keyed hash would not be caught here. Mirrors
     * `auth-audit.service.spec.ts`'s "hashes the SAME IP to a DIFFERENT
     * value under a different secret" test, adapted to a real second
     * `AuthService` module instance (rather than a second
     * `AuthAuditService` instance) so it exercises the session-creation
     * path specifically.
     */
    it('hashes the SAME IP to a DIFFERENT value on Session.ipHash under a different secret (keyed HMAC, not plain hash)', async () => {
      const rawIp = '203.0.113.201';
      const emailDefaultSecret = uniqueEmail('session-ip-hash-secret-default');
      const emailOtherSecret = uniqueEmail('session-ip-hash-secret-other');

      const otherModule: TestingModule = await Test.createTestingModule({
        imports: [JwtModule.register({})],
        providers: [
          AuthService,
          PrismaService,
          AccountLockoutService,
          AuthAuditService,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn().mockReturnValue({
                ...TEST_AUTH_CONFIG,
                authAuditIpHashSecret: OTHER_SECRET,
              }),
            },
          },
        ],
      }).compile();
      const otherService = otherModule.get<AuthService>(AuthService);
      const otherPrisma = otherModule.get<PrismaService>(PrismaService);
      await otherPrisma.onModuleInit();

      try {
        const resultDefaultSecret = await service.register(
          { email: emailDefaultSecret, password: 'correct-horse-battery' },
          { ip: rawIp },
        );
        const resultOtherSecret = await otherService.register(
          { email: emailOtherSecret, password: 'correct-horse-battery' },
          { ip: rawIp },
        );

        const sessionDefaultSecret = await prisma.session.findFirst({
          where: { userId: resultDefaultSecret.user.id },
        });
        const sessionOtherSecret = await otherPrisma.session.findFirst({
          where: { userId: resultOtherSecret.user.id },
        });

        expect(sessionDefaultSecret!.ipHash).not.toBe(
          sessionOtherSecret!.ipHash,
        );
      } finally {
        // The two accounts' rows are cleaned up by this describe block's
        // shared top-level `afterEach` (both emails contain `emailPrefix`,
        // and every `PrismaService` instance — including `otherPrisma` —
        // reads the same `DATABASE_URL`, so `prisma.user.deleteMany` there
        // reaches both). Only this test's OWN extra module/connection
        // needs its own explicit teardown here.
        await otherPrisma.onModuleDestroy();
      }
    });

    it('truncates an overlong user agent to MAX_USER_AGENT_LENGTH on the session row', async () => {
      const email = uniqueEmail('session-metadata-truncate');
      const password = 'correct-horse-battery';
      const overlongUserAgent = `prefix-${'x'.repeat(MAX_USER_AGENT_LENGTH + 50)}`;

      // Registers first (creates the account), then logs in with the
      // overlong user agent — exercises `login`'s call into
      // `issueTokensAndSession`, not just `register`'s.
      await service.register({ email, password });
      const result = await service.login(
        { email, password },
        { userAgent: overlongUserAgent },
      );

      const session = await prisma.session.findFirst({
        where: { userId: result.user.id, revokedAt: null },
        orderBy: { createdAt: 'desc' },
      });

      expect(session!.userAgent).toHaveLength(MAX_USER_AGENT_LENGTH);
      expect(session!.userAgent).toBe(
        overlongUserAgent.slice(0, MAX_USER_AGENT_LENGTH),
      );
    });

    it('omits userAgent/ipHash (stores null) when no request context is supplied', async () => {
      const email = uniqueEmail('session-metadata-no-context');

      const result = await service.register({
        email,
        password: 'correct-horse-battery',
      });

      const session = await prisma.session.findFirst({
        where: { userId: result.user.id },
      });

      expect(session!.userAgent).toBeNull();
      expect(session!.ipHash).toBeNull();
      // `lastUsedAt` is set unconditionally at creation regardless of
      // whether a request context was supplied at all.
      expect(session!.lastUsedAt).not.toBeNull();
    });

    it('sets lastUsedAt on the OLD session at the moment refresh() rotates it out, and on the NEW replacement session', async () => {
      const email = uniqueEmail('session-metadata-refresh');
      const registered = await service.register({
        email,
        password: 'correct-horse-battery',
      });

      const oldSessionBefore = await prisma.session.findFirst({
        where: { userId: registered.user.id },
      });
      expect(oldSessionBefore!.lastUsedAt).not.toBeNull();

      await service.refresh(registered.refreshToken, {
        ip: '203.0.113.9',
        userAgent: 'refresh-agent/2.0',
      });

      const oldSessionAfter = await prisma.session.findUnique({
        where: { id: oldSessionBefore!.id },
      });
      expect(oldSessionAfter!.revokedAt).not.toBeNull();
      expect(oldSessionAfter!.lastUsedAt).not.toBeNull();
      expect(oldSessionAfter!.lastUsedAt!.getTime()).toBeGreaterThanOrEqual(
        oldSessionBefore!.lastUsedAt!.getTime(),
      );

      const newSession = await prisma.session.findFirst({
        where: { userId: registered.user.id, revokedAt: null },
      });
      expect(newSession!.userAgent).toBe('refresh-agent/2.0');
      expect(newSession!.ipHash).not.toBeNull();
      expect(newSession!.lastUsedAt).not.toBeNull();
    });
  });

  /**
   * Phase 12, work unit 12B-B2: `POST /auth/logout-all`'s FROZEN contract —
   * revokes EVERY session for the account, INCLUDING the one used to call
   * it (see `AuthService.logoutAll`'s doc comment for the full rationale).
   */
  describe('logoutAll', () => {
    it('revokes every session for the account, including the current one, and every refresh token stops working', async () => {
      const email = uniqueEmail('logout-all-success');
      const password = 'correct-horse-battery';
      const registered = await service.register({ email, password });
      const secondDevice = await service.login({ email, password });

      await service.logoutAll(registered.user.id);

      const sessions = await prisma.session.findMany({
        where: { userId: registered.user.id },
      });
      expect(sessions.length).toBeGreaterThanOrEqual(2);
      expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);

      // Both the "current" (calling) session's refresh token AND the other
      // device's are now unusable — the frozen contract's whole point.
      await expect(
        service.refresh(registered.refreshToken),
      ).rejects.toMatchObject({
        code: AppErrorCode.INVALID_REFRESH_TOKEN,
      });
      await expect(
        service.refresh(secondDevice.refreshToken),
      ).rejects.toMatchObject({
        code: AppErrorCode.INVALID_REFRESH_TOKEN,
      });

      const auditRows = await prisma.authAuditEvent.findMany({
        where: { userId: registered.user.id, event: 'logout_all_success' },
      });
      expect(auditRows).toHaveLength(1);
    });

    it('does not throw for an account with no active sessions (already logged out everywhere)', async () => {
      const email = uniqueEmail('logout-all-noop');
      const registered = await service.register({
        email,
        password: 'correct-horse-battery',
      });
      await service.logoutAll(registered.user.id);

      await expect(
        service.logoutAll(registered.user.id),
      ).resolves.toBeUndefined();
    });
  });

  /**
   * Phase 12, work unit 12B-B2: `GET /auth/sessions`. Never a hash/secret,
   * never another account's rows.
   */
  describe('listSessions', () => {
    it("lists only the caller's own active sessions, correctly shaped, with no hash anywhere", async () => {
      const email = uniqueEmail('list-sessions-own');
      const password = 'correct-horse-battery';
      const registered = await service.register(
        { email, password },
        { userAgent: 'device-a/1.0' },
      );
      await service.login({ email, password }, { userAgent: 'device-b/1.0' });

      const sessions = await service.listSessions(registered.user.id);

      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.userAgent).sort()).toEqual([
        'device-a/1.0',
        'device-b/1.0',
      ]);
      for (const session of sessions) {
        expect(session.id).toEqual(expect.any(String));
        expect(session.createdAt).toEqual(expect.any(String));
        expect(session.expiresAt).toEqual(expect.any(String));
      }
      expect(JSON.stringify(sessions)).not.toMatch(
        /refreshTokenHash|ipHash|\$2[aby]\$/,
      );
    });

    it("never includes a DIFFERENT account's sessions", async () => {
      const emailA = uniqueEmail('list-sessions-cross-a');
      const emailB = uniqueEmail('list-sessions-cross-b');
      const password = 'correct-horse-battery';
      const registeredA = await service.register({ email: emailA, password });
      await service.register({ email: emailB, password });

      const sessions = await service.listSessions(registeredA.user.id);

      expect(sessions).toHaveLength(1);
    });

    it('excludes revoked sessions', async () => {
      const email = uniqueEmail('list-sessions-excludes-revoked');
      const registered = await service.register({
        email,
        password: 'correct-horse-battery',
      });

      await service.logoutAll(registered.user.id);

      const sessions = await service.listSessions(registered.user.id);
      expect(sessions).toHaveLength(0);
    });
  });

  /**
   * Phase 12, work unit 12B-B2: `DELETE /auth/sessions/:id`. Ownership-scoped
   * revoke — see `AuthService.revokeSession`'s doc comment for the exact
   * IDOR-safety rationale.
   */
  describe('revokeSession', () => {
    it("revokes the caller's own session by id, and that session's refresh token stops working", async () => {
      const email = uniqueEmail('revoke-session-own');
      const registered = await service.register({
        email,
        password: 'correct-horse-battery',
      });
      const session = await prisma.session.findFirst({
        where: { userId: registered.user.id },
      });

      await service.revokeSession(registered.user.id, session!.id);

      const after = await prisma.session.findUnique({
        where: { id: session!.id },
      });
      expect(after!.revokedAt).not.toBeNull();

      await expect(
        service.refresh(registered.refreshToken),
      ).rejects.toMatchObject({
        code: AppErrorCode.INVALID_REFRESH_TOKEN,
      });

      const auditRows = await prisma.authAuditEvent.findMany({
        where: { userId: registered.user.id, event: 'session_revoked' },
      });
      expect(auditRows).toHaveLength(1);
    });

    it("rejects revoking a DIFFERENT account's session with SESSION_NOT_FOUND, and does not revoke it", async () => {
      const emailA = uniqueEmail('revoke-session-cross-a');
      const emailB = uniqueEmail('revoke-session-cross-b');
      const password = 'correct-horse-battery';
      const registeredA = await service.register({ email: emailA, password });
      const registeredB = await service.register({ email: emailB, password });

      const sessionB = await prisma.session.findFirst({
        where: { userId: registeredB.user.id },
      });

      await expect(
        service.revokeSession(registeredA.user.id, sessionB!.id),
      ).rejects.toMatchObject({
        code: AppErrorCode.SESSION_NOT_FOUND,
        status: HttpStatus.NOT_FOUND,
      } as Partial<AppException>);

      const sessionBAfter = await prisma.session.findUnique({
        where: { id: sessionB!.id },
      });
      expect(sessionBAfter!.revokedAt).toBeNull();

      await expect(
        service.refresh(registeredB.refreshToken),
      ).resolves.toBeDefined();
    });

    it('rejects a nonexistent session id with the same SESSION_NOT_FOUND', async () => {
      const email = uniqueEmail('revoke-session-nonexistent');
      const registered = await service.register({
        email,
        password: 'correct-horse-battery',
      });

      await expect(
        service.revokeSession(
          registered.user.id,
          'nonexistent-session-id-cuid',
        ),
      ).rejects.toMatchObject({
        code: AppErrorCode.SESSION_NOT_FOUND,
        status: HttpStatus.NOT_FOUND,
      } as Partial<AppException>);
    });

    it('is idempotent for an already-revoked session (no error, no duplicate audit event)', async () => {
      const email = uniqueEmail('revoke-session-idempotent');
      const registered = await service.register({
        email,
        password: 'correct-horse-battery',
      });
      const session = await prisma.session.findFirst({
        where: { userId: registered.user.id },
      });

      await service.revokeSession(registered.user.id, session!.id);

      await expect(
        service.revokeSession(registered.user.id, session!.id),
      ).resolves.toBeUndefined();

      const auditRows = await prisma.authAuditEvent.findMany({
        where: { userId: registered.user.id, event: 'session_revoked' },
      });
      expect(auditRows).toHaveLength(1);
    });
  });

  /**
   * Phase 12, work unit 12B-B3: `POST /auth/password-reset/request`
   * (DECISIONS.md "Phase 12 ... approved..." entry, decision 3). See
   * `AuthService.requestPasswordReset`'s doc comment for the full
   * anti-enumeration/dev-token design. The default `service`/`prisma`
   * fixture (`TEST_AUTH_CONFIG`, no `app` config override) exercises the
   * production-representative "DEV_TOOLS_ENABLED off" posture, matching
   * this file's existing convention (e.g. `AccountLockoutService`'s tests
   * above never toggle any dev flag either).
   */
  describe('requestPasswordReset', () => {
    it('returns an identical { success: true } shape (no devToken) for BOTH an existing and a nonexistent email', async () => {
      const email = uniqueEmail('reset-request-identical');
      await service.register({ email, password: 'correct-horse-battery' });

      const existingResult = await service.requestPasswordReset({ email });
      const nonexistentResult = await service.requestPasswordReset({
        email: uniqueEmail('reset-request-identical-nonexistent'),
      });

      expect(existingResult).toEqual({ success: true });
      expect(nonexistentResult).toEqual({ success: true });
      expect(existingResult).toEqual(nonexistentResult);
    });

    it('creates a hashed (never raw) PasswordResetToken row for an existing account', async () => {
      const email = uniqueEmail('reset-request-creates-row');
      const registered = await service.register({
        email,
        password: 'correct-horse-battery',
      });

      await service.requestPasswordReset({ email });

      const tokens = await prisma.passwordResetToken.findMany({
        where: { userId: registered.user.id },
      });
      expect(tokens).toHaveLength(1);
      expect(tokens[0].usedAt).toBeNull();
      expect(tokens[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
      // A real HMAC-SHA256 hex digest is 64 characters — proves this is a
      // keyed hash, not the raw token or some other encoding.
      expect(tokens[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('creates NO PasswordResetToken row for a nonexistent email (no enumeration surface, even with raw DB access)', async () => {
      const email = uniqueEmail('reset-request-nonexistent-no-row');

      await service.requestPasswordReset({ email });

      const tokens = await prisma.passwordResetToken.findMany({
        where: { user: { email } },
      });
      expect(tokens).toHaveLength(0);
    });

    it('emits password_reset_requested WITH a userId for a resolved account, and WITHOUT one (reason: user_not_found) for an unresolved email', async () => {
      const email = uniqueEmail('reset-request-audit');
      const registered = await service.register({
        email,
        password: 'correct-horse-battery',
      });
      const nonexistentEmail = uniqueEmail('reset-request-audit-nonexistent');
      // Phase 12, work unit 12A-B3's existing marker-based cleanup
      // precedent (see the "nonexistent email" login test above): a
      // `userId: null` audit row cannot be found via the usual
      // `user: { email: { contains: emailPrefix } }` relation filter, so a
      // distinctive `userAgent` marker (itself containing `emailPrefix`,
      // matching `afterEach`'s existing orphan-cleanup query) is used
      // instead.
      const marker = `${emailPrefix}-reset-request-audit-marker`;

      await service.requestPasswordReset({ email }, { userAgent: marker });
      await service.requestPasswordReset(
        { email: nonexistentEmail },
        { userAgent: marker },
      );

      const foundRow = await prisma.authAuditEvent.findFirst({
        where: {
          userId: registered.user.id,
          event: 'password_reset_requested',
        },
      });
      expect(foundRow).not.toBeNull();
      expect(foundRow?.metadata).toBeNull();

      const notFoundRow = await prisma.authAuditEvent.findFirst({
        where: {
          userId: null,
          event: 'password_reset_requested',
          userAgent: marker,
        },
      });
      expect(notFoundRow).not.toBeNull();
      expect(notFoundRow?.metadata).toEqual({ reason: 'user_not_found' });
    });

    it('never includes the raw email/password anywhere in the response for an existing account', async () => {
      const email = uniqueEmail('reset-request-no-leak');
      await service.register({ email, password: 'correct-horse-battery' });

      const result = await service.requestPasswordReset({ email });

      expect(result).toEqual({ success: true });
      expect(JSON.stringify(result)).not.toContain(email);
    });

    /**
     * DECISIONS.md decision 3: the raw token is returned ONLY when
     * `DEV_TOOLS_ENABLED=true && NODE_ENV != production`. `env.validation.ts`
     * already refuses to boot the app at all if that flag is combined with
     * `NODE_ENV=production` (Phase 10, work unit 10-B5's existing fail-loud
     * check), so a SEPARATE module instance with `app.devToolsEnabled: true`
     * (this test process's own `NODE_ENV` is never `production`) is the
     * correct way to exercise this branch — mirrors this file's existing
     * "otherModule"/"otherPrisma" pattern used above for a different
     * config override.
     */
    describe('with DEV_TOOLS_ENABLED=true', () => {
      let devToolsService: AuthService;
      let devToolsPrisma: PrismaService;

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
              useValue: {
                get: jest.fn((key: string) =>
                  key === 'app' ? { devToolsEnabled: true } : TEST_AUTH_CONFIG,
                ),
              },
            },
          ],
        }).compile();

        devToolsService = module.get<AuthService>(AuthService);
        devToolsPrisma = module.get<PrismaService>(PrismaService);
        await devToolsPrisma.onModuleInit();
      });

      afterEach(async () => {
        await devToolsPrisma.onModuleDestroy();
      });

      it('returns the raw token for an existing account, distinct from the stored (hashed) row', async () => {
        const email = uniqueEmail('reset-request-dev-token');
        const registered = await devToolsService.register({
          email,
          password: 'correct-horse-battery',
        });

        const result = await devToolsService.requestPasswordReset({ email });

        expect(result.success).toBe(true);
        expect(result.devToken).toEqual(expect.any(String));

        const tokenRow = await devToolsPrisma.passwordResetToken.findFirst({
          where: { userId: registered.user.id },
        });
        expect(tokenRow).not.toBeNull();
        expect(result.devToken).not.toBe(tokenRow!.tokenHash);
      });

      it('returns no devToken for a nonexistent email even with DEV_TOOLS_ENABLED=true (nothing was ever created to return)', async () => {
        const result = await devToolsService.requestPasswordReset({
          email: uniqueEmail('reset-request-dev-token-nonexistent'),
        });

        expect(result).toEqual({ success: true });
      });
    });
  });

  /**
   * Phase 12, work unit 12B-B3: `POST /auth/password-reset/confirm`. See
   * `AuthService.confirmPasswordReset`'s doc comment for the full
   * single-use/expiry/revoke-all-sessions design — deliberately MORE
   * aggressive than `changePassword` (every session is revoked, including
   * "the current one" — there is no such concept here — and no replacement
   * session is ever issued).
   *
   * Every test below needs the RAW token to call `confirmPasswordReset`
   * with, which the default (`DEV_TOOLS_ENABLED` off) `service` fixture
   * never returns — so this whole describe block uses its own
   * `DEV_TOOLS_ENABLED=true` module (mirroring `requestPasswordReset`'s
   * identical nested block above) purely to OBTAIN a real raw token for
   * setup; the actual `confirmPasswordReset` behavior under test is
   * identical regardless of that flag (the flag only affects
   * `requestPasswordReset`'s response shape).
   */
  describe('confirmPasswordReset', () => {
    let devToolsService: AuthService;
    let devToolsPrisma: PrismaService;

    // Fix cycle 2 (Phase 12, 12B-B3): the "unknown/garbage token" test below
    // passes no `context.userAgent`, so `confirmPasswordReset`'s
    // `!resetToken` branch (see its doc comment) emits a
    // `password_reset_confirm_failed` row with `userId: null` and no marker —
    // unreachable by the top-level `afterEach`'s existing
    // `userId: null, userAgent: { contains: emailPrefix }` orphan-cleanup
    // query (nothing to `contains`-match against a `null` `userAgent`).
    // Mirrors this file's existing `requestPasswordReset` marker precedent
    // (and `test/password-reset.e2e-spec.ts`'s identical pattern): a
    // distinctive `userAgent` marker lets this describe block's own
    // `afterEach` below find and remove it, scoped to the FULL marker string
    // (not just `emailPrefix`) so it cannot remove any other describe
    // block's or spec file's `userId: null` rows.
    const unknownTokenAuditMarker = `${emailPrefix}-reset-confirm-unknown-token-audit-marker`;

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
            useValue: {
              get: jest.fn((key: string) =>
                key === 'app' ? { devToolsEnabled: true } : TEST_AUTH_CONFIG,
              ),
            },
          },
        ],
      }).compile();

      devToolsService = module.get<AuthService>(AuthService);
      devToolsPrisma = module.get<PrismaService>(PrismaService);
      await devToolsPrisma.onModuleInit();
    });

    afterEach(async () => {
      // Fix cycle 2 (Phase 12, 12B-B3): removes the orphaned `userId: null`
      // row the "unknown/garbage token" test below creates — see the marker
      // comment above for why the top-level `afterEach` cannot reach it.
      await devToolsPrisma.authAuditEvent.deleteMany({
        where: {
          userId: null,
          userAgent: { contains: unknownTokenAuditMarker },
        },
      });
      await devToolsPrisma.onModuleDestroy();
    });

    async function requestRawToken(email: string): Promise<string> {
      const result = await devToolsService.requestPasswordReset({ email });
      return result.devToken!;
    }

    it('sets the new password, revokes EVERY session (including a different device), and the new password works for login', async () => {
      const email = uniqueEmail('reset-confirm-success');
      const oldPassword = 'correct-horse-battery';
      const newPassword = 'brand-new-password-1';
      const registered = await devToolsService.register({
        email,
        password: oldPassword,
      });
      // A "second device" — must ALSO be revoked (frozen contract: EVERY
      // session, a strictly more aggressive scope than changePassword's
      // "every OTHER session").
      await devToolsService.login({ email, password: oldPassword });

      const rawToken = await requestRawToken(email);

      await devToolsService.confirmPasswordReset({
        token: rawToken,
        newPassword,
      });

      const allSessions = await devToolsPrisma.session.findMany({
        where: { userId: registered.user.id },
      });
      expect(allSessions.length).toBeGreaterThanOrEqual(2);
      expect(allSessions.every((s) => s.revokedAt !== null)).toBe(true);

      const storedUser = await devToolsPrisma.user.findUnique({
        where: { email },
      });
      expect(await bcrypt.compare(newPassword, storedUser!.passwordHash)).toBe(
        true,
      );
      expect(await bcrypt.compare(oldPassword, storedUser!.passwordHash)).toBe(
        false,
      );

      await expect(
        devToolsService.login({ email, password: oldPassword }),
      ).rejects.toMatchObject({
        code: AppErrorCode.INVALID_CREDENTIALS,
      });
      const loggedIn = await devToolsService.login({
        email,
        password: newPassword,
      });
      expect(loggedIn.user.email).toBe(email);

      const auditRows = await devToolsPrisma.authAuditEvent.findMany({
        where: {
          userId: registered.user.id,
          event: 'password_reset_confirmed',
        },
      });
      expect(auditRows).toHaveLength(1);
    });

    it('is single-use: a second confirm with the SAME (already-consumed) token fails with INVALID_PASSWORD_RESET_TOKEN and changes nothing further', async () => {
      const email = uniqueEmail('reset-confirm-single-use');
      await devToolsService.register({
        email,
        password: 'correct-horse-battery',
      });
      const rawToken = await requestRawToken(email);

      await devToolsService.confirmPasswordReset({
        token: rawToken,
        newPassword: 'brand-new-password-1',
      });

      await expect(
        devToolsService.confirmPasswordReset({
          token: rawToken,
          newPassword: 'another-new-password-2',
        }),
      ).rejects.toMatchObject({
        code: AppErrorCode.INVALID_PASSWORD_RESET_TOKEN,
        status: HttpStatus.UNAUTHORIZED,
      } as Partial<AppException>);

      // The rejected SECOND attempt's password must not have taken effect.
      const storedUser = await devToolsPrisma.user.findUnique({
        where: { email },
      });
      expect(
        await bcrypt.compare('brand-new-password-1', storedUser!.passwordHash),
      ).toBe(true);
    });

    it('rejects an expired token with INVALID_PASSWORD_RESET_TOKEN and makes no changes', async () => {
      const email = uniqueEmail('reset-confirm-expired');
      const oldPassword = 'correct-horse-battery';
      await devToolsService.register({ email, password: oldPassword });
      const rawToken = await requestRawToken(email);

      await devToolsPrisma.passwordResetToken.updateMany({
        where: { user: { email } },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await expect(
        devToolsService.confirmPasswordReset({
          token: rawToken,
          newPassword: 'brand-new-password-1',
        }),
      ).rejects.toMatchObject({
        code: AppErrorCode.INVALID_PASSWORD_RESET_TOKEN,
        status: HttpStatus.UNAUTHORIZED,
      } as Partial<AppException>);

      const storedUser = await devToolsPrisma.user.findUnique({
        where: { email },
      });
      expect(await bcrypt.compare(oldPassword, storedUser!.passwordHash)).toBe(
        true,
      );
    });

    it('rejects an unknown/garbage token with the same generic INVALID_PASSWORD_RESET_TOKEN error', async () => {
      await expect(
        devToolsService.confirmPasswordReset(
          {
            token: 'this-token-was-never-issued',
            newPassword: 'brand-new-password-1',
          },
          { userAgent: unknownTokenAuditMarker },
        ),
      ).rejects.toMatchObject({
        code: AppErrorCode.INVALID_PASSWORD_RESET_TOKEN,
        status: HttpStatus.UNAUTHORIZED,
      } as Partial<AppException>);
    });

    /**
     * IDOR-safety-equivalent: this endpoint takes no target-account
     * identifier at all — only the token — so a token issued for account A
     * can structurally never reset account B's password. Proven explicitly
     * rather than merely assumed.
     */
    it("a token issued for account A only ever resets account A's password, never account B's", async () => {
      const emailA = uniqueEmail('reset-confirm-cross-a');
      const emailB = uniqueEmail('reset-confirm-cross-b');
      const password = 'correct-horse-battery';
      await devToolsService.register({ email: emailA, password });
      await devToolsService.register({ email: emailB, password });

      const rawTokenA = await requestRawToken(emailA);

      await devToolsService.confirmPasswordReset({
        token: rawTokenA,
        newPassword: 'brand-new-password-1',
      });

      const storedB = await devToolsPrisma.user.findUnique({
        where: { email: emailB },
      });
      expect(await bcrypt.compare(password, storedB!.passwordHash)).toBe(true);
      await expect(
        devToolsService.login({ email: emailB, password }),
      ).resolves.toBeDefined();
    });

    it('never includes the raw token or either password in a thrown error', async () => {
      const email = uniqueEmail('reset-confirm-no-leak');
      await devToolsService.register({
        email,
        password: 'correct-horse-battery',
      });
      const rawToken = await requestRawToken(email);
      await devToolsService.confirmPasswordReset({
        token: rawToken,
        newPassword: 'brand-new-password-1',
      });

      let caughtError: unknown;
      try {
        await devToolsService.confirmPasswordReset({
          token: rawToken,
          newPassword: 'another-new-password-2',
        });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(AppException);
      const serializedError = JSON.stringify({
        message: (caughtError as AppException).message,
        code: (caughtError as AppException).code,
      });
      expect(serializedError).not.toContain(rawToken);
      expect(serializedError).not.toContain('brand-new-password-1');
      expect(serializedError).not.toContain('another-new-password-2');
    });

    it('emits password_reset_confirm_failed with reason "already_used" for a reused token', async () => {
      const email = uniqueEmail('reset-confirm-audit-already-used');
      const registered = await devToolsService.register({
        email,
        password: 'correct-horse-battery',
      });
      const rawToken = await requestRawToken(email);

      await devToolsService.confirmPasswordReset({
        token: rawToken,
        newPassword: 'brand-new-password-1',
      });

      await expect(
        devToolsService.confirmPasswordReset({
          token: rawToken,
          newPassword: 'another-new-password-2',
        }),
      ).rejects.toBeInstanceOf(AppException);

      const auditRows = await devToolsPrisma.authAuditEvent.findMany({
        where: {
          event: 'password_reset_confirm_failed',
          userId: registered.user.id,
        },
      });
      expect(
        auditRows.some(
          (row) =>
            (row.metadata as { reason?: string } | null)?.reason ===
            'already_used',
        ),
      ).toBe(true);
    });

    /**
     * Two concurrent confirms racing the SAME still-valid token: exactly
     * one must win (password changed) and the other must fail cleanly
     * through the same generic `INVALID_PASSWORD_RESET_TOKEN` — never both
     * succeeding (a double-spend of a single-use token) and never both
     * failing (a legitimate reset request stuck unusable).
     */
    it('two concurrent confirms of the SAME token: exactly one succeeds, the other fails cleanly (no double-spend)', async () => {
      const email = uniqueEmail('reset-confirm-race');
      const oldPassword = 'correct-horse-battery';
      await devToolsService.register({ email, password: oldPassword });
      const rawToken = await requestRawToken(email);

      const settled = await Promise.allSettled([
        devToolsService.confirmPasswordReset({
          token: rawToken,
          newPassword: 'password-from-attempt-a',
        }),
        devToolsService.confirmPasswordReset({
          token: rawToken,
          newPassword: 'password-from-attempt-b',
        }),
      ]);

      for (const result of settled) {
        if (result.status === 'rejected') {
          expect(result.reason).toBeInstanceOf(AppException);
          expect((result.reason as AppException).code).toBe(
            AppErrorCode.INVALID_PASSWORD_RESET_TOKEN,
          );
        }
      }

      const fulfilled = settled.filter((r) => r.status === 'fulfilled');
      const rejected = settled.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
    });

    /**
     * Fix cycle 1 (Phase 12, 12B-B3), finding 3: a completed reset must
     * invalidate every OTHER outstanding token for the same account, not
     * just the one that was actually presented — concretely, an attacker who
     * captured an EARLIER reset link/token keeps a live account-takeover
     * credential today even after the legitimate user completes their OWN,
     * LATER reset with a different token, until that earlier token's own
     * 1-hour TTL expires. See `AuthService.confirmPasswordReset`'s doc
     * comment for the full claim-and-invalidate-others design.
     */
    it('confirming one outstanding token invalidates every OTHER outstanding token for the same account', async () => {
      const email = uniqueEmail('reset-confirm-invalidates-others');
      const oldPassword = 'correct-horse-battery';
      const registered = await devToolsService.register({
        email,
        password: oldPassword,
      });

      // Two independently-issued tokens for the SAME account — e.g. an
      // earlier request an attacker captured, plus a later one the
      // legitimate account owner actually uses.
      const olderToken = await requestRawToken(email);
      const newerToken = await requestRawToken(email);

      await devToolsService.confirmPasswordReset({
        token: newerToken,
        newPassword: 'brand-new-password-1',
      });

      // The older token was NEVER itself presented to `confirm` before this
      // point, yet it must no longer work — this is finding 3's entire
      // point: a completed reset invalidates every OTHER outstanding token,
      // not just the one that was used.
      await expect(
        devToolsService.confirmPasswordReset({
          token: olderToken,
          newPassword: 'attacker-supplied-password',
        }),
      ).rejects.toMatchObject({
        code: AppErrorCode.INVALID_PASSWORD_RESET_TOKEN,
        status: HttpStatus.UNAUTHORIZED,
      } as Partial<AppException>);

      // The account's password is the legitimate (newer-token) confirm's,
      // never the rejected older-token attempt's.
      const storedUser = await devToolsPrisma.user.findUnique({
        where: { email },
      });
      expect(
        await bcrypt.compare('brand-new-password-1', storedUser!.passwordHash),
      ).toBe(true);
      expect(
        await bcrypt.compare(
          'attacker-supplied-password',
          storedUser!.passwordHash,
        ),
      ).toBe(false);

      // Both tokens are marked used/invalid AT REST, not merely rejected at
      // the API boundary.
      const tokens = await devToolsPrisma.passwordResetToken.findMany({
        where: { userId: registered.user.id },
      });
      expect(tokens).toHaveLength(2);
      expect(tokens.every((token) => token.usedAt !== null)).toBe(true);
    });

    /**
     * Race-safety re-verification for finding 3 (fix cycle 1): the FIRST
     * attempt at "invalidate the other outstanding tokens" (a CAS scoped to
     * the presented token's own `id`, followed by a SEPARATE broad
     * `updateMany` scoped to `userId != that id`) was rejected before
     * shipping — it is exactly the shape that deadlocked 12B-B1
     * (`changePassword`): two concurrent confirms for two DIFFERENT
     * outstanding tokens of the SAME account would each lock their own token
     * row first, then block trying to lock the OTHER transaction's row,
     * forming a lock-order cycle (Postgres `40P01`). This test reproduces
     * exactly that scenario — real concurrency, real tokens, no mocks — and
     * is looped `PASSWORD_RESET_RACE_TEST_ITERATIONS` (>= 25, per the
     * review's own requirement) times to raise the catch rate for a
     * reintroduced regression, mirroring `RACE_TEST_ITERATIONS`'s existing
     * precedent above for the equivalent `changePassword` races.
     */
    it('N concurrent confirms of TWO DIFFERENT outstanding tokens for the same account never deadlock: exactly one wins, the other fails cleanly', async () => {
      for (
        let iteration = 0;
        iteration < PASSWORD_RESET_RACE_TEST_ITERATIONS;
        iteration++
      ) {
        const email = uniqueEmail(`reset-confirm-two-token-race-${iteration}`);
        await devToolsService.register({
          email,
          password: 'correct-horse-battery',
        });

        const tokenA = await requestRawToken(email);
        const tokenB = await requestRawToken(email);

        const settled = await Promise.allSettled([
          devToolsService.confirmPasswordReset({
            token: tokenA,
            newPassword: 'password-from-attempt-a',
          }),
          devToolsService.confirmPasswordReset({
            token: tokenB,
            newPassword: 'password-from-attempt-b',
          }),
        ]);

        // Neither settlement may be an unhandled/opaque failure — the
        // deadlock shape this guards against (Postgres `40P01`) would
        // surface as a raw `PrismaClientUnknownRequestError`, never a clean
        // `AppException`.
        for (const result of settled) {
          if (result.status === 'rejected') {
            expect(result.reason).toBeInstanceOf(AppException);
            expect((result.reason as AppException).code).toBe(
              AppErrorCode.INVALID_PASSWORD_RESET_TOKEN,
            );
          }
        }

        // Exactly one call wins (password changed) and exactly one loses —
        // never both succeeding (a double-invalidate bypass) and never both
        // failing (a legitimate reset request stuck unusable).
        const fulfilled = settled.filter((r) => r.status === 'fulfilled');
        const rejected = settled.filter((r) => r.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
      }
    }, 60000);
  });
});
