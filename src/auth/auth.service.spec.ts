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
});
