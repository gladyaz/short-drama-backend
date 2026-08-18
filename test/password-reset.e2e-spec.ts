import { Test, TestingModule } from '@nestjs/testing';
import {
  HttpStatus,
  INestApplication,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { getStorageToken, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import type {
  AuthResponseDto,
  PasswordResetRequestResponseDto,
} from './../src/auth/auth.types';
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

/**
 * e2e coverage for Phase 12, work unit 12B-B3 (DECISIONS.md "Phase 12 ...
 * approved..." entry, decision 3): `POST /auth/password-reset/request` and
 * `POST /auth/password-reset/confirm`. Hits the real HTTP layer (routing,
 * the global `ValidationPipe`, `AppExceptionFilter`) against the real
 * `PrismaService` connection, kept in its own file matching
 * `change-password.e2e-spec.ts` / `auth-sessions.e2e-spec.ts`'s existing
 * precedent of one file per new auth-surface behavior.
 *
 * Split into two apps (mirroring `health.e2e-spec.ts` / `entitlements
 * .e2e-spec.ts`'s existing precedent) because `DEV_TOOLS_ENABLED` is read
 * once at `ConfigModule` bootstrap: the "unset" describe below proves the
 * production-representative anti-enumeration contract (no raw token is ever
 * observable over HTTP), and the "DEV_TOOLS_ENABLED=true" describe is the
 * ONLY posture in which a test can obtain a real raw token over HTTP at all
 * — needed to exercise `confirm`'s single-use/expiry/session-revoke
 * behavior end to end.
 */
describe('Auth password reset (e2e)', () => {
  // Kept short deliberately (mirrors `change-password.e2e-spec.ts`'s
  // identical precedent/comment): `@IsEmail()` (via `validator.js`)
  // enforces the RFC 5321 64-character local-part limit, and this prefix is
  // combined with a label + timestamp + random suffix per generated address
  // below.
  // Auth test-stability slice: was the hardcoded literal
  // `'reset-e2e+12bb3'`, byte-identical in every worktree of this repo, so any
  // two concurrent Jest runs sharing `short_drama_test` deleted each
  // other's in-flight fixtures mid-test. See
  // `src/common/testing/fixture-namespace.helpers.ts`.
  const emailPrefix = TEST_FIXTURE_NAMESPACE;
  const uniqueEmail = (label: string): string => fixtureEmail(`pre-${label}`);

  describe('with DEV_TOOLS_ENABLED unset (production-safe posture)', () => {
    let app: INestApplication<App>;
    let prisma: PrismaService;
    let throttlerStorage: ThrottlerStorageService;

    beforeAll(async () => {
      delete process.env.DEV_TOOLS_ENABLED;

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
      // Fix cycle 1 (finding 5): a `password_reset_requested` row for a
      // nonexistent email is created with `userId: null` (see
      // `AuthService.requestPasswordReset`'s doc comment — no
      // `PasswordResetToken`/`User` row ever exists to link it back to), so
      // it structurally cannot match the `user: { email: { contains: ... } }`
      // relation filter above. Mirrors `auth.service.spec.ts`'s existing
      // marker-based cleanup precedent: the nonexistent-email requests below
      // set a distinctive `User-Agent` header containing `emailPrefix`
      // specifically so this query can find and remove them too.
      await prisma.authAuditEvent.deleteMany({
        where: { userId: null, userAgent: { startsWith: emailPrefix } },
      });
      await prisma.session.deleteMany({
        where: { user: { email: { startsWith: emailPrefix } } },
      });
      // `PasswordResetToken` cascades with its `User` (`onDelete: Cascade`),
      // so no separate cleanup is needed for it here.
      await prisma.user.deleteMany({
        where: { email: { startsWith: emailPrefix } },
      });
      await app.close();
    });

    it('returns 202 with an IDENTICAL body ({ success: true }, no devToken key at all) for BOTH an existing and a nonexistent email', async () => {
      const email = uniqueEmail('identical');
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: 'correct-horse-battery' })
        .expect(HttpStatus.CREATED);

      const existingResponse = await request(app.getHttpServer())
        .post('/auth/password-reset/request')
        .send({ email })
        .expect(HttpStatus.ACCEPTED);

      const nonexistentResponse = await request(app.getHttpServer())
        .post('/auth/password-reset/request')
        .set('User-Agent', `${emailPrefix}-identical-nonexistent-audit-marker`)
        .send({ email: uniqueEmail('identical-none') })
        .expect(HttpStatus.ACCEPTED);

      expect(existingResponse.body).toEqual({ success: true });
      expect(nonexistentResponse.body).toEqual({ success: true });
      expect(existingResponse.body).toEqual(nonexistentResponse.body);
      expect(
        existingResponse.body as PasswordResetRequestResponseDto,
      ).not.toHaveProperty('devToken');
    });

    it('rejects an unknown/garbage confirm token with a generic 401 INVALID_PASSWORD_RESET_TOKEN', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/password-reset/confirm')
        .send({
          token: 'this-token-was-never-issued',
          newPassword: 'brand-new-password-1',
        })
        .expect(HttpStatus.UNAUTHORIZED);

      expect((response.body as ErrorResponseBody).code).toBe(
        'INVALID_PASSWORD_RESET_TOKEN',
      );
    });

    it('rejects a newPassword that violates the SAME length policy as registration', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/password-reset/confirm')
        .send({ token: 'irrelevant-for-this-check', newPassword: 'short' })
        .expect(HttpStatus.BAD_REQUEST);

      expect((response.body as ErrorResponseBody).code).toBe('HTTP_ERROR');
    });

    it('rejects an invalid email on request with a validation error (never silently accepted)', async () => {
      await request(app.getHttpServer())
        .post('/auth/password-reset/request')
        .send({ email: 'not-an-email' })
        .expect(HttpStatus.BAD_REQUEST);
    });
  });

  describe('with DEV_TOOLS_ENABLED=true (developer opt-in)', () => {
    let app: INestApplication<App>;
    let prisma: PrismaService;
    let throttlerStorage: ThrottlerStorageService;

    beforeAll(async () => {
      process.env.DEV_TOOLS_ENABLED = 'true';

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
      // Fix cycle 1 (finding 5): see the sibling `describe` block's
      // identical comment above — the nonexistent-email case below sets the
      // same kind of distinctive `User-Agent` marker so its `userId: null`
      // audit row (otherwise unreachable via the `user` relation filter
      // above) is cleaned up too.
      await prisma.authAuditEvent.deleteMany({
        where: { userId: null, userAgent: { startsWith: emailPrefix } },
      });
      await prisma.session.deleteMany({
        where: { user: { email: { startsWith: emailPrefix } } },
      });
      await prisma.user.deleteMany({
        where: { email: { startsWith: emailPrefix } },
      });
      await app.close();
      delete process.env.DEV_TOOLS_ENABLED;
    });

    /** Convenience: register, then request a reset and return the raw dev token. */
    async function requestRawToken(email: string): Promise<string> {
      const response = await request(app.getHttpServer())
        .post('/auth/password-reset/request')
        .send({ email })
        .expect(HttpStatus.ACCEPTED);
      const body = response.body as PasswordResetRequestResponseDto;
      expect(body.devToken).toEqual(expect.any(String));
      return body.devToken!;
    }

    it('returns the raw devToken for an existing account, but omits it for a nonexistent one', async () => {
      const email = uniqueEmail('dev-token-present');
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: 'correct-horse-battery' })
        .expect(HttpStatus.CREATED);

      const existingResponse = await request(app.getHttpServer())
        .post('/auth/password-reset/request')
        .send({ email })
        .expect(HttpStatus.ACCEPTED);
      expect(
        (existingResponse.body as PasswordResetRequestResponseDto).devToken,
      ).toEqual(expect.any(String));

      const nonexistentResponse = await request(app.getHttpServer())
        .post('/auth/password-reset/request')
        .set(
          'User-Agent',
          `${emailPrefix}-dev-token-absent-nonexistent-audit-marker`,
        )
        .send({ email: uniqueEmail('dev-token-absent') })
        .expect(HttpStatus.ACCEPTED);
      expect(nonexistentResponse.body).toEqual({ success: true });
    });

    it('confirms with a valid token, revokes EVERY session (including a second device), and the new password works for login', async () => {
      const email = uniqueEmail('confirm-success');
      const oldPassword = 'correct-horse-battery';
      const newPassword = 'brand-new-password-1';

      const registerResponse = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: oldPassword })
        .expect(HttpStatus.CREATED);
      const registered = registerResponse.body as AuthResponseDto;

      // A second device's session — must ALSO be revoked (frozen contract:
      // EVERY session, a strictly wider scope than `change-password`'s
      // "every OTHER session").
      const secondDeviceResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: oldPassword })
        .expect(HttpStatus.OK);
      const secondDevice = secondDeviceResponse.body as AuthResponseDto;

      const rawToken = await requestRawToken(email);

      await request(app.getHttpServer())
        .post('/auth/password-reset/confirm')
        .send({ token: rawToken, newPassword })
        .expect(HttpStatus.OK)
        .expect({ success: true });

      // Both the original registration's session AND the second device's
      // are now revoked.
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: registered.refreshToken })
        .expect(HttpStatus.UNAUTHORIZED);
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: secondDevice.refreshToken })
        .expect(HttpStatus.UNAUTHORIZED);

      // Old password fails; new password works.
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: oldPassword })
        .expect(HttpStatus.UNAUTHORIZED);
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: newPassword })
        .expect(HttpStatus.OK);

      const auditRows = await prisma.authAuditEvent.findMany({
        where: {
          userId: registered.user.id,
          event: 'password_reset_confirmed',
        },
      });
      expect(auditRows).toHaveLength(1);
    });

    it('is single-use: reusing the same token on a second confirm fails with 401 INVALID_PASSWORD_RESET_TOKEN', async () => {
      const email = uniqueEmail('single-use');
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: 'correct-horse-battery' })
        .expect(HttpStatus.CREATED);

      const rawToken = await requestRawToken(email);

      await request(app.getHttpServer())
        .post('/auth/password-reset/confirm')
        .send({ token: rawToken, newPassword: 'brand-new-password-1' })
        .expect(HttpStatus.OK);

      const response = await request(app.getHttpServer())
        .post('/auth/password-reset/confirm')
        .send({ token: rawToken, newPassword: 'another-new-password-2' })
        .expect(HttpStatus.UNAUTHORIZED);

      expect((response.body as ErrorResponseBody).code).toBe(
        'INVALID_PASSWORD_RESET_TOKEN',
      );

      // The account still has the FIRST confirm's password, not the
      // second (rejected) attempt's.
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: 'brand-new-password-1' })
        .expect(HttpStatus.OK);
    });

    it('rejects an expired token (forced via direct DB update) with 401 INVALID_PASSWORD_RESET_TOKEN and makes no changes', async () => {
      const email = uniqueEmail('expired');
      const oldPassword = 'correct-horse-battery';
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: oldPassword })
        .expect(HttpStatus.CREATED);

      const rawToken = await requestRawToken(email);

      await prisma.passwordResetToken.updateMany({
        where: { user: { email } },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const response = await request(app.getHttpServer())
        .post('/auth/password-reset/confirm')
        .send({ token: rawToken, newPassword: 'brand-new-password-1' })
        .expect(HttpStatus.UNAUTHORIZED);
      expect((response.body as ErrorResponseBody).code).toBe(
        'INVALID_PASSWORD_RESET_TOKEN',
      );

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: oldPassword })
        .expect(HttpStatus.OK);
    });

    /**
     * Cross-account isolation: this endpoint takes no target-account
     * identifier at all (only the token), so a token issued for account A
     * can structurally never reset account B's password.
     */
    it("a token issued for account A never resets account B's password", async () => {
      const emailA = uniqueEmail('cross-a');
      const emailB = uniqueEmail('cross-b');
      const password = 'correct-horse-battery';
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: emailA, password })
        .expect(HttpStatus.CREATED);
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: emailB, password })
        .expect(HttpStatus.CREATED);

      const rawTokenA = await requestRawToken(emailA);

      await request(app.getHttpServer())
        .post('/auth/password-reset/confirm')
        .send({ token: rawTokenA, newPassword: 'brand-new-password-1' })
        .expect(HttpStatus.OK);

      // B's original password still works, completely untouched.
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: emailB, password })
        .expect(HttpStatus.OK);
    });

    /**
     * The raw token is genuinely secret material for the lifetime of the
     * reset flow (anyone who obtains it can take over the account) — this
     * proves it never reaches ANY log line across the real request+confirm
     * (success) and request+confirm (already-used failure) code paths, not
     * merely that the HTTP response omits it.
     */
    /**
     * Password-reset invalidation slice, over the real HTTP surface: a
     * successful `POST /auth/change-password` ends the account's previous
     * credential generation, so a reset token issued before it can no longer
     * confirm. Before this slice this exact sequence SUCCEEDED and re-wrote
     * the password the owner had just set.
     */
    it('a reset token issued before a successful change-password can no longer confirm, and is indistinguishable from an unknown token', async () => {
      const email = uniqueEmail('stale-after-change');
      const oldPassword = 'correct-horse-battery';
      const changedPassword = 'changed-password-e2e-1';

      const registerResponse = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: oldPassword })
        .expect(HttpStatus.CREATED);
      const registered = registerResponse.body as AuthResponseDto;

      const staleToken = await requestRawToken(email);

      await request(app.getHttpServer())
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${registered.accessToken}`)
        .send({
          currentPassword: oldPassword,
          newPassword: changedPassword,
          refreshToken: registered.refreshToken,
        })
        .expect(HttpStatus.OK);

      const staleResponse = await request(app.getHttpServer())
        .post('/auth/password-reset/confirm')
        .send({ token: staleToken, newPassword: 'attacker-supplied-e2e-1' })
        .expect(HttpStatus.UNAUTHORIZED);
      const staleBody = staleResponse.body as ErrorResponseBody;
      expect(staleBody.code).toBe('INVALID_PASSWORD_RESET_TOKEN');

      // Byte-identical to the response a token that never existed gets —
      // nothing in the client-facing contract reveals that this particular
      // token died because the account's password was changed.
      const unknownResponse = await request(app.getHttpServer())
        .post('/auth/password-reset/confirm')
        .set('User-Agent', `${emailPrefix}-stale-after-change-unknown-marker`)
        .send({
          token: 'this-token-was-never-issued',
          newPassword: 'attacker-supplied-e2e-1',
        })
        .expect(HttpStatus.UNAUTHORIZED);
      expect(staleResponse.body).toEqual(unknownResponse.body);

      // The rejected confirm changed nothing: the owner's new password is
      // the account's password.
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: 'attacker-supplied-e2e-1' })
        .expect(HttpStatus.UNAUTHORIZED);
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: changedPassword })
        .expect(HttpStatus.OK);
    });

    it('recovery still works after a change-password: a token requested afterwards confirms normally', async () => {
      const email = uniqueEmail('recovery-after-change');
      const oldPassword = 'correct-horse-battery';
      const changedPassword = 'changed-password-e2e-2';
      const recoveredPassword = 'recovered-password-e2e-2';

      const registerResponse = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: oldPassword })
        .expect(HttpStatus.CREATED);
      const registered = registerResponse.body as AuthResponseDto;

      const staleToken = await requestRawToken(email);

      await request(app.getHttpServer())
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${registered.accessToken}`)
        .send({
          currentPassword: oldPassword,
          newPassword: changedPassword,
          refreshToken: registered.refreshToken,
        })
        .expect(HttpStatus.OK);

      // The point of this test: killing the old generation's tokens must not
      // disable account recovery itself.
      const freshToken = await requestRawToken(email);
      expect(freshToken).not.toBe(staleToken);

      await request(app.getHttpServer())
        .post('/auth/password-reset/confirm')
        .send({ token: freshToken, newPassword: recoveredPassword })
        .expect(HttpStatus.OK)
        .expect({ success: true });

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: recoveredPassword })
        .expect(HttpStatus.OK);

      // ...and the stale token is still dead afterwards.
      await request(app.getHttpServer())
        .post('/auth/password-reset/confirm')
        .send({ token: staleToken, newPassword: 'attacker-supplied-e2e-2' })
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('never writes the raw token to any log line across a full request+confirm(+reuse) cycle', async () => {
      const email = uniqueEmail('no-log-leak');
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: 'correct-horse-battery' })
        .expect(HttpStatus.CREATED);

      const logSpy = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const debugSpy = jest
        .spyOn(Logger.prototype, 'debug')
        .mockImplementation(() => undefined);

      try {
        const rawToken = await requestRawToken(email);

        await request(app.getHttpServer())
          .post('/auth/password-reset/confirm')
          .send({ token: rawToken, newPassword: 'brand-new-password-1' })
          .expect(HttpStatus.OK);

        // Reusing the now-consumed token — the failure path must not leak
        // it into a log line either.
        await request(app.getHttpServer())
          .post('/auth/password-reset/confirm')
          .send({ token: rawToken, newPassword: 'another-new-password-2' })
          .expect(HttpStatus.UNAUTHORIZED);

        const allCalls = [
          ...logSpy.mock.calls,
          ...errorSpy.mock.calls,
          ...warnSpy.mock.calls,
          ...debugSpy.mock.calls,
        ];
        for (const call of allCalls) {
          for (const argument of call) {
            expect(String(argument)).not.toContain(rawToken);
          }
        }
      } finally {
        logSpy.mockRestore();
        errorSpy.mockRestore();
        warnSpy.mockRestore();
        debugSpy.mockRestore();
      }
    });
  });
});
