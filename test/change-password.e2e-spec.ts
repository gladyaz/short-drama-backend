import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { getStorageToken, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import type { AuthResponseDto } from './../src/auth/auth.types';
import { bcryptTestBudgetMs } from './../src/common/testing/bcrypt-test-budget.helpers';
import {
  TEST_FIXTURE_NAMESPACE,
  fixtureEmail,
} from './../src/common/testing/fixture-namespace.helpers';
import { resetThrottlerStorage } from './../src/common/testing/throttler-reset.helpers';

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

const GENERIC_INVALID_CREDENTIALS_BODY: ErrorResponseBody = {
  statusCode: HttpStatus.UNAUTHORIZED,
  code: 'INVALID_CREDENTIALS',
  message: 'Invalid email or password',
};

/**
 * e2e coverage for Phase 12, work unit 12B-B1 (DECISIONS.md "Phase 12 ...
 * approved..." entry, decision 7): `POST /auth/change-password`. Hits the
 * real HTTP layer (routing, `JwtAuthGuard`, global `ValidationPipe`,
 * `AppExceptionFilter`) against the real `PrismaService` connection, kept in
 * its own file matching `auth-rate-limit-lockout.e2e-spec.ts` /
 * `auth-audit.e2e-spec.ts`'s existing precedent of one file per new
 * auth-surface behavior. Self-cleaning via `afterAll`.
 */
describe('Auth change-password (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let throttlerStorage: ThrottlerStorageService;

  // Kept short deliberately: `@IsEmail()` (via `validator.js`) enforces the
  // RFC 5321 64-character local-part limit, and this prefix is combined
  // with a label + timestamp + random suffix per generated address below
  // (see `auth-rate-limit-lockout.e2e-spec.ts`'s identical precedent).
  // Auth test-stability slice: was the hardcoded literal
  // `'cp-e2e+12bb1'`, byte-identical in every worktree of this repo, so any
  // two concurrent Jest runs sharing `short_drama_test` deleted each
  // other's in-flight fixtures mid-test. See
  // `src/common/testing/fixture-namespace.helpers.ts`.
  const emailPrefix = TEST_FIXTURE_NAMESPACE;
  const uniqueEmail = (label: string): string => fixtureEmail(`cpe-${label}`);

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

  beforeEach(() => {
    resetThrottlerStorage(throttlerStorage);
  });

  afterAll(async () => {
    await prisma.authAuditEvent.deleteMany({
      where: { user: { email: { startsWith: emailPrefix } } },
    });
    await prisma.session.deleteMany({
      where: { user: { email: { startsWith: emailPrefix } } },
    });
    await prisma.user.deleteMany({
      where: { email: { startsWith: emailPrefix } },
    });
    await app.close();
  });

  it('changes the password, revokes every OTHER session, rotates the current session token pair, and never leaks a hash', async () => {
    const email = uniqueEmail('success');
    const oldPassword = 'correct-horse-battery';
    const newPassword = 'brand-new-password-1';

    const registerResponse = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: oldPassword })
      .expect(HttpStatus.CREATED);
    const registered = registerResponse.body as AuthResponseDto;

    // A second device's session — must ALSO be revoked (every OTHER
    // session, not just one). Its token is never read again; only the side
    // effect (a second `Session` row) matters here.
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: oldPassword })
      .expect(HttpStatus.OK);

    const changeResponse = await request(app.getHttpServer())
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${registered.accessToken}`)
      .send({
        currentPassword: oldPassword,
        newPassword,
        refreshToken: registered.refreshToken,
      })
      .expect(HttpStatus.OK);

    const changed = changeResponse.body as AuthResponseDto;
    expect(changed.user.email).toBe(email);
    expect(changed.accessToken).toEqual(expect.any(String));
    expect(changed.refreshToken).toEqual(expect.any(String));
    expect(changed.refreshToken).not.toBe(registered.refreshToken);
    // Never a session record, a `refreshTokenHash`, or any hash/secret in
    // the response body.
    expect(JSON.stringify(changed)).not.toMatch(
      /passwordHash|refreshTokenHash|revokedAt|\$2[aby]\$/,
    );

    // Every session for the account except the brand-new one is revoked —
    // checked directly against the DB, not by calling `/auth/refresh` with
    // an already-revoked token (that call has its OWN side effect, replay
    // detection's defensive revoke-EVERYTHING, which would contaminate this
    // exact assertion — see the dedicated "replay" test below).
    const allSessions = await prisma.session.findMany({
      where: { user: { email } },
    });
    expect(allSessions.filter((s) => s.revokedAt === null)).toHaveLength(1);
    expect(
      allSessions.filter((s) => s.revokedAt !== null).length,
    ).toBeGreaterThanOrEqual(2);

    // The NEW refresh token issued BY change-password itself keeps
    // working — the calling device stays authenticated with fresh
    // credentials, it was not merely logged out.
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: changed.refreshToken })
      .expect(HttpStatus.OK);

    // Logging in with the OLD password now fails; the NEW password works.
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: oldPassword })
      .expect(HttpStatus.UNAUTHORIZED);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: newPassword })
      .expect(HttpStatus.OK);

    const auditRows = await prisma.authAuditEvent.findMany({
      where: { userId: registered.user.id, event: 'change_password_success' },
    });
    expect(auditRows).toHaveLength(1);
  });

  it('rejects a wrong current password with the SAME generic body login failures use, and leaves the session usable', async () => {
    const email = uniqueEmail('wrong-current-pw');
    const correctPassword = 'correct-horse-battery';

    const registerResponse = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: correctPassword })
      .expect(HttpStatus.CREATED);
    const registered = registerResponse.body as AuthResponseDto;

    const response = await request(app.getHttpServer())
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${registered.accessToken}`)
      .send({
        currentPassword: 'totally-wrong-password',
        newPassword: 'brand-new-password-1',
        refreshToken: registered.refreshToken,
      })
      .expect(HttpStatus.UNAUTHORIZED);

    expect(response.body).toEqual(GENERIC_INVALID_CREDENTIALS_BODY);

    // The session is untouched by a failed attempt — the presented refresh
    // token still works.
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: registered.refreshToken })
      .expect(HttpStatus.OK);

    const auditRows = await prisma.authAuditEvent.findMany({
      where: { userId: registered.user.id, event: 'change_password_failed' },
    });
    expect(auditRows).toHaveLength(1);
  });

  it('rejects a new password that violates the SAME length policy as registration', async () => {
    const email = uniqueEmail('new-pw-too-short');
    const correctPassword = 'correct-horse-battery';

    const registerResponse = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: correctPassword })
      .expect(HttpStatus.CREATED);
    const registered = registerResponse.body as AuthResponseDto;

    const response = await request(app.getHttpServer())
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${registered.accessToken}`)
      .send({
        currentPassword: correctPassword,
        newPassword: 'short',
        refreshToken: registered.refreshToken,
      })
      .expect(HttpStatus.BAD_REQUEST);

    expect((response.body as ErrorResponseBody).code).toBe('HTTP_ERROR');

    // The session/password must be untouched by a rejected request.
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: registered.refreshToken })
      .expect(HttpStatus.OK);
  });

  it('rejects an unauthenticated call with no Authorization header', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/change-password')
      .send({
        currentPassword: 'whatever',
        newPassword: 'brand-new-password-1',
        refreshToken: 'irrelevant-for-this-check',
      })
      .expect(HttpStatus.UNAUTHORIZED);

    expect((response.body as ErrorResponseBody).code).toBe(
      'INVALID_ACCESS_TOKEN',
    );
  });

  /**
   * IDOR-safety: an authenticated caller supplying ANOTHER account's real,
   * currently-valid refresh token must never be able to use it as "the
   * current session" — this must be impossible, not merely unlikely.
   */
  it('rejects a refresh token belonging to a DIFFERENT account (cross-account attempt) and changes nothing', async () => {
    const emailA = uniqueEmail('cross-account-a');
    const emailB = uniqueEmail('cross-account-b');
    const correctPassword = 'correct-horse-battery';

    const registerAResponse = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: emailA, password: correctPassword })
      .expect(HttpStatus.CREATED);
    const registeredA = registerAResponse.body as AuthResponseDto;

    const registerBResponse = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: emailB, password: correctPassword })
      .expect(HttpStatus.CREATED);
    const registeredB = registerBResponse.body as AuthResponseDto;

    const response = await request(app.getHttpServer())
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${registeredA.accessToken}`)
      .send({
        currentPassword: correctPassword,
        newPassword: 'brand-new-password-1',
        refreshToken: registeredB.refreshToken,
      })
      .expect(HttpStatus.UNAUTHORIZED);

    expect((response.body as ErrorResponseBody).code).toBe(
      'INVALID_REFRESH_TOKEN',
    );

    // Neither account was touched: A's password is unchanged (still logs in
    // with the original password) and B's session is still active.
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: emailA, password: correctPassword })
      .expect(HttpStatus.OK);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: registeredB.refreshToken })
      .expect(HttpStatus.OK);
  });

  /**
   * Preserves `AuthService.refresh`'s existing replay-detection UNCHANGED:
   * since change-password REVOKES (not deletes) the pre-change session,
   * reusing its refresh token afterward must be caught by that same
   * existing detection — and must still trigger its defensive
   * revoke-every-session-for-the-account behavior.
   */
  it('after rotation, reusing the OLD (pre-change-password) refresh token is detected as replay and revokes every session', async () => {
    const email = uniqueEmail('replay-detection');
    const correctPassword = 'correct-horse-battery';
    const newPassword = 'brand-new-password-1';

    const registerResponse = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: correctPassword })
      .expect(HttpStatus.CREATED);
    const registered = registerResponse.body as AuthResponseDto;

    await request(app.getHttpServer())
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${registered.accessToken}`)
      .send({
        currentPassword: correctPassword,
        newPassword,
        refreshToken: registered.refreshToken,
      })
      .expect(HttpStatus.OK);

    // Reusing the pre-change-password refresh token must fail exactly like
    // any other rotated-token replay.
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: registered.refreshToken })
      .expect(HttpStatus.UNAUTHORIZED);

    const sessions = await prisma.session.findMany({
      where: { user: { email } },
    });
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);

    const reuseEvents = await prisma.authAuditEvent.findMany({
      where: { userId: registered.user.id, event: 'refresh_reuse_detected' },
    });
    expect(
      reuseEvents.some(
        (row) =>
          (row.metadata as { reason?: string } | null)?.reason ===
          'already_rotated',
      ),
    ).toBe(true);
  });
});
