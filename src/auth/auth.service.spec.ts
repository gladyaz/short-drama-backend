import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { HttpStatus } from '@nestjs/common';
import type { Session } from '@prisma/client';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';

const TEST_AUTH_CONFIG = {
  jwtAccessSecret: 'test-access-secret-not-a-real-secret',
  jwtRefreshSecret: 'test-refresh-secret-not-a-real-secret',
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
        await service.login({
          email: uniqueEmail('login-shape-nonexistent'),
          password: 'totally-wrong-password',
        });
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
});
