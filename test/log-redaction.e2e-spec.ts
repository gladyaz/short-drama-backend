import { Test, TestingModule } from '@nestjs/testing';
import {
  HttpStatus,
  INestApplication,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getStorageToken, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AccountLockoutService } from './../src/auth/account-lockout.service';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import type { RootConfig } from './../src/config/configuration';
import {
  TEST_FIXTURE_NAMESPACE,
  fixtureEmail,
} from './../src/common/testing/fixture-namespace.helpers';

interface ErrorResponseBody {
  statusCode: number;
  code: string;
  message: string;
}

/**
 * Phase 12, work unit 12A-B4: redaction/secret-leak verification pass —
 * regression coverage proving (end to end, over real HTTP, through the real
 * `AppExceptionFilter` + `redactSensitiveText` pipeline) that:
 *   1. Error responses from auth routes (bad login, bad refresh, validation
 *      errors, a genuine 500) never contain a real secret/token/password/
 *      hash value, checked against the actual configured values — not just
 *      a hardcoded fixture string, so this would catch a future regression
 *      that accidentally serializes config into a response body.
 *   2. A deliberately-triggered unhandled exception whose message embeds
 *      secret-shaped text is never written to the log line verbatim — this
 *      is asserted against a CAPTURED logger (`jest.spyOn(Logger.prototype,
 *      'error')`), not just the HTTP response, since the leak this unit
 *      guards against is a log line, not only an HTTP body.
 *
 * Unlike `auth.e2e-spec.ts`/`auth-rate-limit-lockout.e2e-spec.ts` (which
 * test functional behavior), this file is purely about what NEVER appears
 * in a response body or a log line.
 */
describe('Secret/token log + error-response redaction (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let configService: ConfigService<RootConfig>;
  let accountLockoutService: AccountLockoutService;
  let throttlerStorage: ThrottlerStorageService;

  // Auth test-stability slice: was the hardcoded literal
  // `'log-redaction-e2e+12a-b4'`. Two independent defects, one fix:
  //  1. Byte-identical in every worktree of this repo, so any two
  //     concurrent Jest runs sharing `short_drama_test` deleted each
  //     other's in-flight fixtures mid-test.
  //  2. At 24 characters, combined with this file's longest label and the
  //     old `${Date.now()}-${Math.random().toString(36).slice(2)}` suffix,
  //     it produced an email whose LOCAL PART exceeded the RFC 5321
  //     64-character limit whenever `Math.random()` happened to emit a
  //     long base-36 tail — measured at 2.4% of generations. `@IsEmail()`
  //     then rejected it and `POST /auth/register` returned 400 instead of
  //     201, failing this suite for a reason that had nothing to do with
  //     log redaction. The namespaced form is fixed-width and 20+
  //     characters shorter, so it cannot recur.
  // See `src/common/testing/fixture-namespace.helpers.ts`.
  const emailPrefix = TEST_FIXTURE_NAMESPACE;
  const uniqueEmail = (label: string): string => fixtureEmail(`lr-${label}`);

  // The actual configured secrets for this test run — pulled from the real
  // config/env, not a fixture string, so these assertions genuinely prove
  // "the real secret never appears", not merely "a string I invented never
  // appears".
  let realSecrets: string[];

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
    configService = moduleFixture.get<ConfigService<RootConfig>>(ConfigService);
    accountLockoutService = moduleFixture.get<AccountLockoutService>(
      AccountLockoutService,
    );
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(getStorageToken());

    const authConfig = configService.get('auth', { infer: true })!;
    const storageConfig = configService.get('storage', { infer: true })!;
    realSecrets = [
      authConfig.jwtAccessSecret,
      authConfig.jwtRefreshSecret,
      authConfig.authAuditIpHashSecret,
      storageConfig.accessKeyId,
      storageConfig.secretAccessKey,
      // DATABASE_URL isn't part of RootConfig (Prisma reads it directly from
      // process.env), but it's exactly the kind of value this unit's
      // contract requires never leaks — check it directly against the env.
      process.env.DATABASE_URL ?? '',
    ].filter((value) => value.length > 0);
  });

  afterEach(() => {
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

  /** No configured secret value appears anywhere in `body`. */
  function expectNoRealSecretLeak(body: unknown): void {
    const serialized = JSON.stringify(body);
    for (const secret of realSecrets) {
      expect(serialized).not.toContain(secret);
    }
  }

  describe('error responses never leak a real secret/token/password/hash', () => {
    it('a bad-password login error response contains no configured secret value', async () => {
      const email = uniqueEmail('bad-login');
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: 'correct-horse-battery' })
        .expect(HttpStatus.CREATED);

      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: 'definitely-wrong-password' })
        .expect(HttpStatus.UNAUTHORIZED);

      expectNoRealSecretLeak(response.body);
      expect((response.body as ErrorResponseBody).message).toBe(
        'Invalid email or password',
      );
    });

    it('a bad-refresh-token error response contains no configured secret value', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: 'never-issued-refresh-token-value' })
        .expect(HttpStatus.UNAUTHORIZED);

      expectNoRealSecretLeak(response.body);
    });

    it('a validation error response contains no configured secret value', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'not-an-email', password: 'short' })
        .expect(HttpStatus.BAD_REQUEST);

      expectNoRealSecretLeak(response.body);
    });

    it('a deliberately-triggered 500 (unhandled exception mid-login) responds with the generic body and no configured secret value', async () => {
      const email = uniqueEmail('forced-500');
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: 'correct-horse-battery' })
        .expect(HttpStatus.CREATED);

      const isLockedSpy = jest
        .spyOn(accountLockoutService, 'isLocked')
        .mockRejectedValueOnce(
          new Error('simulated downstream failure (no secret here)'),
        );

      try {
        const response = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email, password: 'correct-horse-battery' })
          .expect(HttpStatus.INTERNAL_SERVER_ERROR);

        expect(response.body).toEqual({
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
        });
        expectNoRealSecretLeak(response.body);
      } finally {
        isLockedSpy.mockRestore();
      }
    });
  });

  describe('a deliberately-triggered error never writes a raw secret to a log line', () => {
    it('redacts a fake secret/token embedded in an unhandled exception message before it reaches the logger', async () => {
      const email = uniqueEmail('logged-secret');
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: 'correct-horse-battery' })
        .expect(HttpStatus.CREATED);

      const FAKE_PASSWORD = 'fake-do-not-log-password-9f8e7d6c';
      const FAKE_RESET_TOKEN = 'fake-do-not-log-resetToken-1a2b3c4d';
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const isLockedSpy = jest
        .spyOn(accountLockoutService, 'isLocked')
        .mockRejectedValueOnce(
          new Error(
            `simulated downstream failure carrying secret-shaped fields: password: "${FAKE_PASSWORD}", resetToken: "${FAKE_RESET_TOKEN}"`,
          ),
        );

      try {
        const response = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email, password: 'correct-horse-battery' })
          .expect(HttpStatus.INTERNAL_SERVER_ERROR);

        // The HTTP response itself must never carry it either.
        expect(JSON.stringify(response.body)).not.toContain(FAKE_PASSWORD);
        expect(JSON.stringify(response.body)).not.toContain(FAKE_RESET_TOKEN);

        // Find the specific log call for THIS simulated failure (the spy is
        // global and may have captured unrelated lines from other in-flight
        // activity) and assert its content is redacted, not merely that
        // *some* call happened.
        const loggedLines = errorSpy.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.includes('simulated downstream failure'));

        expect(loggedLines.length).toBeGreaterThan(0);
        for (const line of loggedLines) {
          expect(line).not.toContain(FAKE_PASSWORD);
          expect(line).not.toContain(FAKE_RESET_TOKEN);
          expect(line).toContain('[REDACTED]');
        }
      } finally {
        isLockedSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });
});
