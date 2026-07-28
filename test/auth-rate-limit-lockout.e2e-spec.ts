import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { getStorageToken, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import type { AuthResponseDto } from './../src/auth/auth.types';

interface ErrorResponseBody {
  statusCode: number;
  code: string;
  message: string;
}

const GENERIC_INVALID_CREDENTIALS_BODY: ErrorResponseBody = {
  statusCode: HttpStatus.UNAUTHORIZED,
  code: 'INVALID_CREDENTIALS',
  message: 'Invalid email or password',
};

/**
 * e2e coverage for Phase 12, work unit 12A-B1 (DECISIONS.md "Phase 12 ...
 * approved..." entry, decision 4): `@nestjs/throttler` IP rate limits on
 * `/auth/login|register|refresh`, and the persistent PostgreSQL account
 * lockout. Kept in its own file (separate from `auth.e2e-spec.ts`) so the
 * pre-existing functional auth e2e coverage stays focused on
 * register/login/refresh/logout *behavior*, and this file stays focused on
 * the new rate-limit/lockout *security* behavior. Self-cleaning via
 * `afterAll`, matching the `auth.e2e-spec.ts` precedent.
 */
describe('Auth rate limiting + account lockout (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let throttlerStorage: ThrottlerStorageService;

  // Kept short deliberately: `@IsEmail()` (via `validator.js`) enforces the
  // RFC 5321 64-character local-part limit, and this prefix is combined
  // with a label + timestamp + random suffix per generated address below.
  const emailPrefix = 'rl-lockout-e2e+12ab1';
  const uniqueEmail = (label: string): string =>
    `${emailPrefix}-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new AppExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(getStorageToken());
  });

  afterAll(async () => {
    await prisma.accountLockout.deleteMany({
      where: { user: { email: { contains: emailPrefix } } },
    });
    await prisma.session.deleteMany({
      where: { user: { email: { contains: emailPrefix } } },
    });
    await prisma.user.deleteMany({
      where: { email: { contains: emailPrefix } },
    });
    await app.close();
  });

  // Each test's own request count starts from zero: no test here relies on
  // (or is broken by) another test's requests against the shared in-memory
  // throttler storage.
  beforeEach(() => {
    throttlerStorage.storage.clear();
  });

  describe('IP rate limiting', () => {
    it('returns a generic 429 on the 4th /auth/register call within the window (limit 3/10min)', async () => {
      const register = (label: string) =>
        request(app.getHttpServer())
          .post('/auth/register')
          .send({
            email: uniqueEmail(label),
            password: 'correct-horse-battery',
          });

      await register('rl-1').expect(HttpStatus.CREATED);
      await register('rl-2').expect(HttpStatus.CREATED);
      await register('rl-3').expect(HttpStatus.CREATED);

      const blocked = await register('rl-4').expect(
        HttpStatus.TOO_MANY_REQUESTS,
      );

      const body = blocked.body as ErrorResponseBody;
      expect(body.statusCode).toBe(HttpStatus.TOO_MANY_REQUESTS);
      // Generic: no hint about which email/account triggered it.
      expect(JSON.stringify(body)).not.toMatch(/@example\.test/);
    });

    it('returns a generic 429 on the 6th /auth/login call within the window (limit 5/min)', async () => {
      const email = uniqueEmail('login-rl');
      const attemptLogin = () =>
        request(app.getHttpServer())
          .post('/auth/login')
          .send({ email, password: 'irrelevant-wrong-password' });

      for (let i = 0; i < 5; i += 1) {
        await attemptLogin().expect(HttpStatus.UNAUTHORIZED);
      }

      const blocked = await attemptLogin().expect(HttpStatus.TOO_MANY_REQUESTS);
      expect((blocked.body as ErrorResponseBody).statusCode).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
    });

    it('returns a generic 429 on the 31st /auth/refresh call within the window (limit 30/min)', async () => {
      const email = uniqueEmail('refresh-rl');
      const registerResponse = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: 'correct-horse-battery' })
        .expect(HttpStatus.CREATED);

      let refreshToken = (registerResponse.body as AuthResponseDto)
        .refreshToken;

      for (let i = 0; i < 30; i += 1) {
        const response = await request(app.getHttpServer())
          .post('/auth/refresh')
          .send({ refreshToken })
          .expect(HttpStatus.OK);
        refreshToken = (response.body as AuthResponseDto).refreshToken;
      }

      const blocked = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken })
        .expect(HttpStatus.TOO_MANY_REQUESTS);
      expect((blocked.body as ErrorResponseBody).statusCode).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }, 20000);

    /**
     * Phase 12, work unit 12B-B3: `POST /auth/password-reset/request` is
     * unauthenticated, exactly like register/login/refresh above, so it
     * gets the same style of tight per-route override (see
     * `PASSWORD_RESET_REQUEST_RATE_LIMIT`'s doc comment for the
     * 3/10min threshold/rationale — deliberately the SAME limit as
     * `/auth/register`).
     */
    it('returns a generic 429 on the 4th /auth/password-reset/request call within the window (limit 3/10min)', async () => {
      const email = uniqueEmail('reset-req-rl');
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: 'correct-horse-battery' })
        .expect(HttpStatus.CREATED);

      const requestReset = () =>
        request(app.getHttpServer())
          .post('/auth/password-reset/request')
          .send({ email });

      await requestReset().expect(HttpStatus.ACCEPTED);
      await requestReset().expect(HttpStatus.ACCEPTED);
      await requestReset().expect(HttpStatus.ACCEPTED);

      const blocked = await requestReset().expect(HttpStatus.TOO_MANY_REQUESTS);
      const body = blocked.body as ErrorResponseBody;
      expect(body.statusCode).toBe(HttpStatus.TOO_MANY_REQUESTS);
      // Generic: no hint about which email/account triggered it.
      expect(JSON.stringify(body)).not.toMatch(/@example\.test/);
    });

    /**
     * `POST /auth/password-reset/confirm` is also unauthenticated (no
     * access token — the presented token itself is the only credential),
     * so it gets its own tight override too (see
     * `PASSWORD_RESET_CONFIRM_RATE_LIMIT`'s doc comment — the SAME
     * threshold as `/auth/login`). A garbage token is used throughout so
     * this test never depends on `requestPasswordReset`'s dev-only raw
     * -token exposure.
     */
    it('returns a generic 429 on the 6th /auth/password-reset/confirm call within the window (limit 5/min)', async () => {
      const attemptConfirm = () =>
        request(app.getHttpServer()).post('/auth/password-reset/confirm').send({
          token: 'never-issued-reset-token',
          newPassword: 'brand-new-password-1',
        });

      for (let i = 0; i < 5; i += 1) {
        await attemptConfirm().expect(HttpStatus.UNAUTHORIZED);
      }

      const blocked = await attemptConfirm().expect(
        HttpStatus.TOO_MANY_REQUESTS,
      );
      expect((blocked.body as ErrorResponseBody).statusCode).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
    });
  });

  describe('Persistent account lockout', () => {
    it('locks the account after the 10th failed login and rejects a SUBSEQUENT CORRECT password with the identical generic error', async () => {
      const email = uniqueEmail('lock-basic');
      const correctPassword = 'correct-horse-battery';
      const registerResponse = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: correctPassword })
        .expect(HttpStatus.CREATED);
      const userId = (registerResponse.body as AuthResponseDto).user.id;

      // Seed 9 prior failures directly (the increment-by-increment logic
      // itself is already covered by `account-lockout.service.spec.ts`) so
      // this e2e test reaches the lock via a SINGLE real HTTP call, staying
      // well under the separately-tested 5/min login IP throttle above.
      await prisma.accountLockout.create({
        data: { userId, failedCount: 9, windowStartedAt: new Date() },
      });

      const wrongPasswordResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: 'totally-wrong-password' })
        .expect(HttpStatus.UNAUTHORIZED);

      const lockoutAfterTenth = await prisma.accountLockout.findUnique({
        where: { userId },
      });
      expect(lockoutAfterTenth?.lockedUntil).not.toBeNull();
      expect(lockoutAfterTenth!.lockedUntil!.getTime()).toBeGreaterThan(
        Date.now(),
      );

      const lockedCorrectPasswordResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: correctPassword })
        .expect(HttpStatus.UNAUTHORIZED);

      expect(lockedCorrectPasswordResponse.body).toEqual(
        wrongPasswordResponse.body,
      );
      expect(lockedCorrectPasswordResponse.body).toEqual(
        GENERIC_INVALID_CREDENTIALS_BODY,
      );
    });

    it('allows login again once the lock window has elapsed (time simulated via the stored timestamp, not a real wait)', async () => {
      const email = uniqueEmail('lock-exp');
      const correctPassword = 'correct-horse-battery';
      const registerResponse = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: correctPassword })
        .expect(HttpStatus.CREATED);
      const userId = (registerResponse.body as AuthResponseDto).user.id;

      await prisma.accountLockout.create({
        data: {
          userId,
          failedCount: 10,
          windowStartedAt: new Date(Date.now() - 20 * 60 * 1000),
          lockedUntil: new Date(Date.now() - 1000), // already elapsed
        },
      });

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: correctPassword })
        .expect(HttpStatus.OK);

      const lockoutAfterSuccess = await prisma.accountLockout.findUnique({
        where: { userId },
      });
      expect(lockoutAfterSuccess?.failedCount).toBe(0);
      expect(lockoutAfterSuccess?.lockedUntil).toBeNull();
    });

    it('a nonexistent account, a wrong password, and a locked account all return byte-identical response bodies', async () => {
      const email = uniqueEmail('lock-shape');
      const correctPassword = 'correct-horse-battery';
      const registerResponse = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: correctPassword })
        .expect(HttpStatus.CREATED);
      const userId = (registerResponse.body as AuthResponseDto).user.id;

      const nonexistentResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: uniqueEmail('lock-shape-none'),
          password: 'whatever-password',
        })
        .expect(HttpStatus.UNAUTHORIZED);

      const wrongPasswordResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: 'a-different-wrong-password' })
        .expect(HttpStatus.UNAUTHORIZED);

      // `upsert`, not `create`: the wrong-password attempt just above
      // already recorded one real failure via `AccountLockoutService`, so a
      // row already exists for this account.
      await prisma.accountLockout.upsert({
        where: { userId },
        create: {
          userId,
          failedCount: 10,
          windowStartedAt: new Date(),
          lockedUntil: new Date(Date.now() + 15 * 60 * 1000),
        },
        update: {
          failedCount: 10,
          windowStartedAt: new Date(),
          lockedUntil: new Date(Date.now() + 15 * 60 * 1000),
        },
      });

      const lockedResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: correctPassword })
        .expect(HttpStatus.UNAUTHORIZED);

      expect(nonexistentResponse.body).toEqual(wrongPasswordResponse.body);
      expect(wrongPasswordResponse.body).toEqual(lockedResponse.body);
      expect(lockedResponse.body).toEqual(GENERIC_INVALID_CREDENTIALS_BODY);
    });
  });
});
