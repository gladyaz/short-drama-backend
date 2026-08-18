import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getStorageToken, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import type { AuthResponseDto } from './../src/auth/auth.types';
import type { RootConfig } from './../src/config/configuration';
import { bcryptTestBudgetMs } from './../src/common/testing/bcrypt-test-budget.helpers';
import {
  TEST_FIXTURE_NAMESPACE,
  fixtureEmail,
} from './../src/common/testing/fixture-namespace.helpers';

/**
 * Auth test-stability slice: replaces Jest's inherited 5000ms default, which
 * was never sized for a suite that drives REAL cost-factor-12 bcrypt hashing
 * through the full HTTP stack. A single test here commonly performs 4-8 such
 * operations (~1.8-3.5s of irreducible CPU work with the worker pool
 * saturated) before any database or Nest overhead. See
 * `src/common/testing/bcrypt-test-budget.helpers.ts` — a harness
 * hang-detector budget, NOT a business-security timeout: no production
 * timeout, token lifetime, lockout window, or throttle window is changed by
 * this.
 */
jest.setTimeout(bcryptTestBudgetMs(8));

interface ErrorResponseBody {
  statusCode: number;
  code: string;
  message: string;
}

/**
 * e2e coverage for `POST /auth/register|login|refresh|logout` (Phase 8,
 * work unit 8-B5), hitting the real HTTP layer (routing, global
 * `ValidationPipe`, `AppExceptionFilter`) against the real dev SQLite
 * database via the app's own `PrismaModule`. Self-cleaning: every user/email
 * created here is prefixed and removed in `afterAll`.
 */
describe('Auth (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let configService: ConfigService<RootConfig>;
  let throttlerStorage: ThrottlerStorageService;

  // Auth test-stability slice: was the hardcoded literal
  // `'auth-e2e-spec+8b5'`, byte-identical in every worktree of this repo, so any
  // two concurrent Jest runs sharing `short_drama_test` deleted each
  // other's in-flight fixtures mid-test. See
  // `src/common/testing/fixture-namespace.helpers.ts`.
  const emailPrefix = TEST_FIXTURE_NAMESPACE;
  const uniqueEmail = (label: string): string => fixtureEmail(`ae-${label}`);

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
    jwtService = moduleFixture.get<JwtService>(JwtService);
    configService = moduleFixture.get<ConfigService<RootConfig>>(ConfigService);
    // `ThrottlerModule.forRoot` registers its storage provider under the
    // `ThrottlerStorage` injection token (a symbol), not the
    // `ThrottlerStorageService` class itself — `getStorageToken()` is the
    // package's own exported helper for looking it up.
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(getStorageToken());
  });

  // Phase 12, work unit 12A-B1: `/auth/register|login|refresh` are now
  // IP-rate-limited (see `rate-limit.constants.ts`). This whole spec file
  // shares a single `app` instance (and therefore a single in-memory
  // `ThrottlerStorageService`) across many `it()` blocks that each
  // legitimately call these routes — clearing the tracked-request storage
  // before every test keeps each test's own request count isolated, so the
  // PRE-EXISTING functional assertions below (register/login/refresh/logout
  // behavior) are unaffected by the new rate limits. Dedicated rate-limit
  // *exceeding* behavior is covered by
  // `auth-rate-limit-lockout.e2e-spec.ts`, which does not share this reset.
  beforeEach(() => {
    throttlerStorage.storage.clear();
  });

  afterAll(async () => {
    await prisma.session.deleteMany({
      where: { user: { email: { startsWith: emailPrefix } } },
    });
    await prisma.user.deleteMany({
      where: { email: { startsWith: emailPrefix } },
    });
    await app.close();
  });

  it('registers a new user and returns a token pair with no password fields leaked', async () => {
    const email = uniqueEmail('register');

    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email,
        password: 'correct-horse-battery',
        displayName: 'E2E User',
      })
      .expect(HttpStatus.CREATED);

    const body = response.body as AuthResponseDto;
    expect(body.user.email).toBe(email);
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.refreshToken).toEqual(expect.any(String));
    expect(JSON.stringify(body)).not.toMatch(/passwordHash|\$2[aby]\$/);
  });

  it('rejects registration with an invalid email and a too-short password', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'not-an-email', password: 'short' })
      .expect(HttpStatus.BAD_REQUEST);

    const body = response.body as ErrorResponseBody;
    expect(body.code).toBe('HTTP_ERROR');
  });

  it('rejects registering the same email twice with a structured 409', async () => {
    const email = uniqueEmail('register-conflict');

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'correct-horse-battery' })
      .expect(HttpStatus.CREATED);

    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'another-password-1' })
      .expect(HttpStatus.CONFLICT);

    expect(response.body).toEqual({
      statusCode: HttpStatus.CONFLICT,
      code: 'EMAIL_ALREADY_REGISTERED',
      message: 'An account with this email already exists',
    });
  });

  it('logs in with correct credentials', async () => {
    const email = uniqueEmail('login');
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'correct-horse-battery' })
      .expect(HttpStatus.CREATED);

    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'correct-horse-battery' })
      .expect(HttpStatus.OK);

    const body = response.body as AuthResponseDto;
    expect(body.user.email).toBe(email);
    expect(body.accessToken).toEqual(expect.any(String));
  });

  it('rejects a wrong password and a nonexistent email with the identical generic error body', async () => {
    const email = uniqueEmail('login-wrong');
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'correct-horse-battery' })
      .expect(HttpStatus.CREATED);

    const wrongPasswordResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'nope-thats-wrong' })
      .expect(HttpStatus.UNAUTHORIZED);

    const nonexistentEmailResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: uniqueEmail('login-nonexistent'),
        password: 'nope-thats-wrong',
      })
      .expect(HttpStatus.UNAUTHORIZED);

    expect(wrongPasswordResponse.body).toEqual(nonexistentEmailResponse.body);
    expect(wrongPasswordResponse.body).toEqual({
      statusCode: HttpStatus.UNAUTHORIZED,
      code: 'INVALID_CREDENTIALS',
      message: 'Invalid email or password',
    });
  });

  it('refreshes a token pair, rotating the refresh token, then rejects reuse of the old one', async () => {
    const email = uniqueEmail('refresh-flow');
    const registerResponse = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'correct-horse-battery' })
      .expect(HttpStatus.CREATED);

    const oldRefreshToken = (registerResponse.body as AuthResponseDto)
      .refreshToken;

    const refreshResponse = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: oldRefreshToken })
      .expect(HttpStatus.OK);

    const refreshBody = refreshResponse.body as AuthResponseDto;
    expect(refreshBody.refreshToken).not.toBe(oldRefreshToken);
    expect(refreshBody.accessToken).toEqual(expect.any(String));

    // Reusing the old (now-rotated) refresh token must fail.
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: oldRefreshToken })
      .expect(HttpStatus.UNAUTHORIZED);
  });

  it('rejects an unknown refresh token', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: 'never-issued-token-value' })
      .expect(HttpStatus.UNAUTHORIZED);

    expect((response.body as ErrorResponseBody).code).toBe(
      'INVALID_REFRESH_TOKEN',
    );
  });

  it('logs out, then rejects a subsequent refresh with that token', async () => {
    const email = uniqueEmail('logout-flow');
    const registerResponse = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'correct-horse-battery' })
      .expect(HttpStatus.CREATED);

    const refreshToken = (registerResponse.body as AuthResponseDto)
      .refreshToken;

    await request(app.getHttpServer())
      .post('/auth/logout')
      .send({ refreshToken })
      .expect(HttpStatus.OK);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken })
      .expect(HttpStatus.UNAUTHORIZED);
  });

  /**
   * `GET /auth/me` (Phase 8, work unit 8-B6): the concrete, end-to-end proof
   * that `JwtAuthGuard` actually protects a route, using a real access token
   * from the real register flow rather than a mock.
   */
  describe('GET /auth/me', () => {
    it('rejects a request with no Authorization header', async () => {
      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .expect(HttpStatus.UNAUTHORIZED);

      expect((response.body as ErrorResponseBody).code).toBe(
        'INVALID_ACCESS_TOKEN',
      );
    });

    it('returns the authenticated user for a valid access token', async () => {
      const email = uniqueEmail('me-valid');
      const registerResponse = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email,
          password: 'correct-horse-battery',
          displayName: 'Me Route User',
        })
        .expect(HttpStatus.CREATED);

      const { accessToken } = registerResponse.body as AuthResponseDto;

      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK);

      expect(response.body).toMatchObject({
        email,
        displayName: 'Me Route User',
      });
      expect(JSON.stringify(response.body)).not.toMatch(
        /passwordHash|\$2[aby]\$/,
      );
    });

    it('rejects an expired access token', async () => {
      const email = uniqueEmail('me-expired');
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: 'correct-horse-battery' })
        .expect(HttpStatus.CREATED);

      const authConfig = configService.get('auth', { infer: true })!;
      const expiredToken = await jwtService.signAsync(
        { sub: 'irrelevant-for-this-check' },
        { secret: authConfig.jwtAccessSecret, expiresIn: '0s' },
      );
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${expiredToken}`)
        .expect(HttpStatus.UNAUTHORIZED);

      expect((response.body as ErrorResponseBody).code).toBe(
        'INVALID_ACCESS_TOKEN',
      );
      // Auth test-stability slice: the explicit 10000 here was REMOVED rather
      // than converted. It had become the tightest budget in this file — below
      // the file-level default above — so this test now simply inherits that
      // higher default. Its cost is a hard 1100ms token-expiry wait plus HTTP
      // round trips, not bcrypt, so no derived budget applies.
    });

    it('rejects a token with an invalid signature', async () => {
      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', 'Bearer not.a.valid.jwt.signature')
        .expect(HttpStatus.UNAUTHORIZED);

      expect((response.body as ErrorResponseBody).code).toBe(
        'INVALID_ACCESS_TOKEN',
      );
    });

    /**
     * Work unit 8-B7: closes the gap flagged (LOW, non-blocking) during
     * 8-B6's review — this exact path ("user deleted after token issuance,
     * then calls /auth/me") had been verified correct by code inspection
     * only, with no automated test. `JwtAuthGuard` only verifies the token
     * itself (see its doc comment), so a still-valid access token for a
     * since-deleted user reaches `AuthService.getUserById`, which is
     * expected to translate the missing row into the same generic 401.
     */
    it('rejects a still-valid access token whose user has since been deleted', async () => {
      const email = uniqueEmail('me-deleted-user');
      const registerResponse = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: 'correct-horse-battery' })
        .expect(HttpStatus.CREATED);

      const { accessToken, user } = registerResponse.body as AuthResponseDto;

      await prisma.session.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });

      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.UNAUTHORIZED);

      expect((response.body as ErrorResponseBody).code).toBe(
        'INVALID_ACCESS_TOKEN',
      );
    });
  });
});
