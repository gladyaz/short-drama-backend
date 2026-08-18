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

const GENERIC_INVALID_REFRESH_TOKEN_BODY: ErrorResponseBody = {
  statusCode: HttpStatus.UNAUTHORIZED,
  code: 'INVALID_REFRESH_TOKEN',
  message: 'Invalid or expired refresh token',
};

/**
 * Regression coverage for a test-reviewer finding (fix cycle 1, follow-up to
 * work unit 12C-B1): `AuthService.login`/`AuthService.refresh` racing a
 * CONCURRENT `POST /users/me/deletion` for the SAME account could hit an
 * unhandled `PrismaClientKnownRequestError` (`P2003`,
 * `Session_userId_fkey`) once `deleteAccount`'s transaction had already
 * removed the `User` row — nothing caught it, so `AppExceptionFilter`'s
 * generic catch-all returned a raw, undocumented `500` instead of the same
 * clean "user vanished mid-flight" error each of these methods already
 * throws for every OTHER version of this condition. See
 * `AuthService.issueTokensAndSession`'s `onUserVanished` parameter (and its
 * doc comment) for the fix itself.
 *
 * Fires the racing HTTP request pair via `Promise.all` (not sequentially),
 * matching the reviewer's own reproduction method, against the real
 * `PrismaService` connection — redirected to the isolated test database for
 * the whole e2e run by `test/jest-e2e.setup.ts`. Neither request's outcome
 * is forced; both branches (the requester wins the race and gets a normal
 * `200`, or loses it and gets the documented `401`) are accepted, and only
 * the never-observed-as-anything-else invariant (never a `500`, and the
 * `401` body always matches the pre-existing generic error exactly) is
 * asserted. Iteration counts are chosen from the reviewer's own empirical
 * hit rates (login: 19/20; refresh: 1/20, a much narrower window) so that,
 * WITHOUT the fix, at least one iteration reliably reproduces the raw `500`
 * this test exists to catch.
 */
describe('Account deletion vs login/refresh concurrency (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let throttlerStorage: ThrottlerStorageService;

  // Kept short deliberately: `@IsEmail()` (via `validator.js`) enforces the
  // RFC 5321 64-character local-part limit — matches
  // `auth-rate-limit-lockout.e2e-spec.ts`/`account-deletion.e2e-spec.ts`'s
  // identical precedent.
  // Auth test-stability slice: was the hardcoded literal
  // `'ad-race-e2e+12cb1fix'`, byte-identical in every worktree of this repo, so any
  // two concurrent Jest runs sharing `short_drama_test` deleted each
  // other's in-flight fixtures mid-test. See
  // `src/common/testing/fixture-namespace.helpers.ts`.
  const emailPrefix = TEST_FIXTURE_NAMESPACE;
  const uniqueEmail = (label: string): string => fixtureEmail(`arc-${label}`);

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
    await prisma.session.deleteMany({
      where: { user: { email: { startsWith: emailPrefix } } },
    });
    await prisma.user.deleteMany({
      where: { email: { startsWith: emailPrefix } },
    });
    await app.close();
  });

  // Each iteration below registers a fresh account, then immediately races
  // it against its own deletion — several distinct routes' dedicated
  // `@Throttle()` overrides (`register`: 3/10min, `login`: 5/min,
  // `deletion`: 5/15min) would otherwise trip long before 20-30 iterations
  // complete. Clearing the whole in-memory throttler store before each
  // account is registered sidesteps this exactly like every other e2e spec
  // in this suite that needs more attempts than the real limits allow
  // (matches `account-deletion.e2e-spec.ts`'s identical `beforeEach`
  // precedent, just called per-iteration here instead of per-`it`).
  async function registerAccount(
    label: string,
    password: string,
  ): Promise<{ email: string; auth: AuthResponseDto }> {
    throttlerStorage.storage.clear();
    const email = uniqueEmail(label);
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(HttpStatus.CREATED);
    return { email, auth: response.body as AuthResponseDto };
  }

  it(
    'login() racing a concurrent deleteAccount() for the same account never returns a raw 500 (20 iterations)',
    async () => {
      const password = 'correct-horse-battery';

      for (let i = 0; i < 20; i += 1) {
        const { email, auth } = await registerAccount(
          `login-race-${i}`,
          password,
        );
        throttlerStorage.storage.clear();

        const [loginResponse, deletionResponse] = await Promise.all([
          request(app.getHttpServer())
            .post('/auth/login')
            .send({ email, password }),
          request(app.getHttpServer())
            .post('/users/me/deletion')
            .set('Authorization', `Bearer ${auth.accessToken}`)
            .send({ currentPassword: password, confirmDeletion: true }),
        ]);

        const loginStatus: number = loginResponse.status;
        expect([HttpStatus.OK, HttpStatus.UNAUTHORIZED]).toContain(loginStatus);
        if (Number(loginStatus) === Number(HttpStatus.UNAUTHORIZED)) {
          expect(loginResponse.body).toEqual(GENERIC_INVALID_CREDENTIALS_BODY);
        } else {
          expect((loginResponse.body as AuthResponseDto).accessToken).toEqual(
            expect.any(String),
          );
        }

        // Unaffected by the race either way — see this file's doc comment.
        expect(deletionResponse.status).toBe(HttpStatus.OK);
        expect(deletionResponse.body).toEqual({ success: true });
      }
      // 20 iterations x 3 real cost-12 bcrypt operations (register 1, racing
      // login 1, deleteAccount 1). At the measured saturated cost that is ~27s
      // of pure hashing, which the previous flat 30000ms could not cover — this
      // test failed on EVERY baseline e2e run on this hardware.
    },
    bcryptTestBudgetMs(20 * 3),
  );

  it(
    'refresh() racing a concurrent deleteAccount() for the same account never returns a raw 500 (30 iterations)',
    async () => {
      const password = 'correct-horse-battery';

      for (let i = 0; i < 30; i += 1) {
        const { auth } = await registerAccount(`refresh-race-${i}`, password);
        throttlerStorage.storage.clear();

        const [refreshResponse, deletionResponse] = await Promise.all([
          request(app.getHttpServer())
            .post('/auth/refresh')
            .send({ refreshToken: auth.refreshToken }),
          request(app.getHttpServer())
            .post('/users/me/deletion')
            .set('Authorization', `Bearer ${auth.accessToken}`)
            .send({ currentPassword: password, confirmDeletion: true }),
        ]);

        const refreshStatus: number = refreshResponse.status;
        expect([HttpStatus.OK, HttpStatus.UNAUTHORIZED]).toContain(
          refreshStatus,
        );
        if (Number(refreshStatus) === Number(HttpStatus.UNAUTHORIZED)) {
          expect(refreshResponse.body).toEqual(
            GENERIC_INVALID_REFRESH_TOKEN_BODY,
          );
        } else {
          expect((refreshResponse.body as AuthResponseDto).accessToken).toEqual(
            expect.any(String),
          );
        }

        // Unaffected by the race either way — see this file's doc comment.
        expect(deletionResponse.status).toBe(HttpStatus.OK);
        expect(deletionResponse.body).toEqual({ success: true });
      }
      // 30 iterations x 2 real cost-12 bcrypt operations (register 1,
      // deleteAccount 1 — `refresh` performs none).
    },
    bcryptTestBudgetMs(30 * 2),
  );
});
