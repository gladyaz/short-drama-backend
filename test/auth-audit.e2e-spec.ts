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

/** A real HMAC-SHA256 hex digest is exactly 64 lowercase hex characters. */
const HEX64_PATTERN = /^[0-9a-f]{64}$/;

/**
 * e2e coverage for Phase 12, work unit 12A-B3 (DECISIONS.md "Phase 12 ...
 * approved..." entry, decision 6): `AuthAuditEvent` rows written from the
 * real HTTP `/auth/*` endpoints, end-to-end (routing, global
 * `ValidationPipe`, `AppExceptionFilter`, real `PrismaService`). Kept in its
 * own file (matching `auth-rate-limit-lockout.e2e-spec.ts`'s precedent) so
 * the pre-existing functional `auth.e2e-spec.ts` coverage stays focused on
 * request/response *behavior*, and this file stays focused on the new audit
 * *side effect*. Self-cleaning via `afterAll`.
 */
describe('Auth audit logging (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let throttlerStorage: ThrottlerStorageService;

  // Auth test-stability slice: was the hardcoded literal
  // `'auth-audit-e2e+12ab3'`, byte-identical in every worktree of this repo, so any
  // two concurrent Jest runs sharing `short_drama_test` deleted each
  // other's in-flight fixtures mid-test. See
  // `src/common/testing/fixture-namespace.helpers.ts`.
  const emailPrefix = TEST_FIXTURE_NAMESPACE;
  const uniqueEmail = (label: string): string => fixtureEmail(`aae-${label}`);

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
    await prisma.authAuditEvent.deleteMany({
      where: { user: { email: { startsWith: emailPrefix } } },
    });
    await prisma.accountLockout.deleteMany({
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

  // Matches `auth-rate-limit-lockout.e2e-spec.ts`'s precedent: each test's
  // own request count starts from zero against the shared in-memory
  // throttler, so this file's assertions are never affected by
  // `/auth/login`'s 5/min IP limit.
  beforeEach(() => {
    resetThrottlerStorage(throttlerStorage);
  });

  it('a successful login writes a login_success AuthAuditEvent row (not AnalyticsEvent) with no raw email/password/token, and the HTTP response is unaffected', async () => {
    const email = uniqueEmail('login-success');
    const password = 'correct-horse-battery';

    const registerResponse = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(HttpStatus.CREATED);
    const { user } = registerResponse.body as AuthResponseDto;

    const analyticsCountBefore = await prisma.analyticsEvent.count({
      where: { userId: user.id },
    });

    const loginResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .set('User-Agent', 'auth-audit-e2e-agent/1.0')
      .send({ email, password })
      .expect(HttpStatus.OK);

    const loginBody = loginResponse.body as AuthResponseDto;
    expect(loginBody.user.email).toBe(email);
    expect(loginBody.accessToken).toEqual(expect.any(String));
    expect(loginBody.refreshToken).toEqual(expect.any(String));

    const auditRows = await prisma.authAuditEvent.findMany({
      where: { userId: user.id, event: 'login_success' },
    });
    expect(auditRows).toHaveLength(1);

    const row = auditRows[0];
    expect(row.userAgent).toBe('auth-audit-e2e-agent/1.0');
    expect(row.ipHash).not.toBeNull();
    expect(row.ipHash).toMatch(HEX64_PATTERN);

    const serializedRow = JSON.stringify(row);
    expect(serializedRow).not.toContain(email);
    expect(serializedRow).not.toContain(password);
    expect(serializedRow).not.toContain(loginBody.accessToken);
    expect(serializedRow).not.toContain(loginBody.refreshToken);

    // Confirms this is genuinely a SEPARATE table/pipeline from the
    // product-analytics one — logging in must never create an
    // `AnalyticsEvent` row as a side effect.
    const analyticsCountAfter = await prisma.analyticsEvent.count({
      where: { userId: user.id },
    });
    expect(analyticsCountAfter).toBe(analyticsCountBefore);
  });

  it('a failed login writes a login_failed AuthAuditEvent row with no raw password, and the HTTP response is unchanged (anti-enumeration)', async () => {
    const email = uniqueEmail('login-failed');
    const correctPassword = 'correct-horse-battery';

    const registerResponse = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: correctPassword })
      .expect(HttpStatus.CREATED);
    const { user } = registerResponse.body as AuthResponseDto;

    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'totally-wrong-password' })
      .expect(HttpStatus.UNAUTHORIZED);

    expect(response.body).toEqual(GENERIC_INVALID_CREDENTIALS_BODY);

    const auditRows = await prisma.authAuditEvent.findMany({
      where: { userId: user.id, event: 'login_failed' },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].metadata).toEqual({ reason: 'invalid_password' });

    const serializedRow = JSON.stringify(auditRows[0]);
    expect(serializedRow).not.toContain('totally-wrong-password');
    expect(serializedRow).not.toContain(email);
  });

  it('hitting the lockout writes an account_locked AuthAuditEvent row, and the HTTP response stays byte-identical to a normal failure', async () => {
    const email = uniqueEmail('account-locked');
    const correctPassword = 'correct-horse-battery';

    const registerResponse = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: correctPassword })
      .expect(HttpStatus.CREATED);
    const { user } = registerResponse.body as AuthResponseDto;

    // Seed an ALREADY-locked account directly (the increment-by-increment
    // path to a fresh lock is already covered by
    // `auth-rate-limit-lockout.e2e-spec.ts`/`account-lockout.service.spec.ts`)
    // so this test reaches the "account_locked" branch — which only fires on
    // an attempt made WHILE already locked, not the attempt that causes the
    // lock — via a single real HTTP call.
    await prisma.accountLockout.create({
      data: {
        userId: user.id,
        failedCount: 10,
        windowStartedAt: new Date(),
        lockedUntil: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    // Uses the CORRECT password to prove the lock itself (not merely a wrong
    // password) is what's being logged/refused.
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: correctPassword })
      .expect(HttpStatus.UNAUTHORIZED);

    expect(response.body).toEqual(GENERIC_INVALID_CREDENTIALS_BODY);

    const auditRows = await prisma.authAuditEvent.findMany({
      where: { userId: user.id, event: 'account_locked' },
    });
    expect(auditRows).toHaveLength(1);

    const serializedRow = JSON.stringify(auditRows[0]);
    expect(serializedRow).not.toContain(email);
    expect(serializedRow).not.toContain(correctPassword);
  });
});
