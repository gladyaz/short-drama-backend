import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { HttpStatus } from '@nestjs/common';
import type { Session } from '@prisma/client';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { AccountLockoutService } from './account-lockout.service';
import { AuthAuditService } from './auth-audit.service';
import { AuthService } from './auth.service';

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
