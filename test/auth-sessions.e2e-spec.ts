import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { getStorageToken, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import type {
  AuthResponseDto,
  SessionSummaryDto,
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
 * e2e coverage for Phase 12, work unit 12B-B2 (DECISIONS.md "Phase 12 ...
 * approved..." entry, decision 6): `POST /auth/logout-all`,
 * `GET /auth/sessions`, `DELETE /auth/sessions/:id`, and the additive
 * `Session.userAgent`/`ipHash`/`lastUsedAt` columns. Hits the real HTTP
 * layer (routing, `JwtAuthGuard`, global `ValidationPipe`,
 * `AppExceptionFilter`) against the real `PrismaService` connection, kept in
 * its own file matching `change-password.e2e-spec.ts` / `auth-audit.e2e-spec.ts`'s
 * existing precedent of one file per new auth-surface behavior.
 * Self-cleaning via `afterAll`.
 */
describe('Auth sessions (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let throttlerStorage: ThrottlerStorageService;

  // Kept short deliberately (mirrors `change-password.e2e-spec.ts`'s
  // identical precedent/comment): `@IsEmail()` (via `validator.js`)
  // enforces the RFC 5321 64-character local-part limit, and this prefix
  // is combined with a label + timestamp + random suffix per generated
  // address below.
  // Auth test-stability slice: was the hardcoded literal
  // `'sess-e2e+12bb2'`, byte-identical in every worktree of this repo, so any
  // two concurrent Jest runs sharing `short_drama_test` deleted each
  // other's in-flight fixtures mid-test. See
  // `src/common/testing/fixture-namespace.helpers.ts`.
  const emailPrefix = TEST_FIXTURE_NAMESPACE;
  const uniqueEmail = (label: string): string => fixtureEmail(`se-${label}`);

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

  describe('POST /auth/logout-all', () => {
    it('revokes EVERY session for the account, including the calling device, and every refresh token stops working', async () => {
      const email = uniqueEmail('logout-all');
      const password = 'correct-horse-battery';

      const registerResponse = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password })
        .expect(HttpStatus.CREATED);
      const registered = registerResponse.body as AuthResponseDto;

      // A second device's session — must ALSO be revoked.
      const loginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password })
        .expect(HttpStatus.OK);
      const secondDevice = loginResponse.body as AuthResponseDto;

      await request(app.getHttpServer())
        .post('/auth/logout-all')
        .set('Authorization', `Bearer ${registered.accessToken}`)
        .expect(HttpStatus.OK)
        .expect({ success: true });

      // The frozen contract: the CALLING device's own refresh token is
      // revoked too, not spared.
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: registered.refreshToken })
        .expect(HttpStatus.UNAUTHORIZED);
      // The other device's session is also revoked.
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: secondDevice.refreshToken })
        .expect(HttpStatus.UNAUTHORIZED);

      const auditRows = await prisma.authAuditEvent.findMany({
        where: { userId: registered.user.id, event: 'logout_all_success' },
      });
      expect(auditRows).toHaveLength(1);
    });

    it('rejects an unauthenticated call with no Authorization header', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/logout-all')
        .expect(HttpStatus.UNAUTHORIZED);

      expect((response.body as ErrorResponseBody).code).toBe(
        'INVALID_ACCESS_TOKEN',
      );
    });
  });

  describe('GET /auth/sessions', () => {
    it("lists only the caller's own active sessions, correctly shaped, with no hash/secret anywhere in the body", async () => {
      const email = uniqueEmail('list-own');
      const password = 'correct-horse-battery';

      const registerResponse = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password })
        .set('User-Agent', 'e2e-device-a/1.0')
        .expect(HttpStatus.CREATED);
      const registered = registerResponse.body as AuthResponseDto;

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password })
        .set('User-Agent', 'e2e-device-b/1.0')
        .expect(HttpStatus.OK);

      const listResponse = await request(app.getHttpServer())
        .get('/auth/sessions')
        .set('Authorization', `Bearer ${registered.accessToken}`)
        .expect(HttpStatus.OK);

      const sessions = listResponse.body as SessionSummaryDto[];
      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.userAgent).sort()).toEqual([
        'e2e-device-a/1.0',
        'e2e-device-b/1.0',
      ]);
      for (const session of sessions) {
        expect(session.id).toEqual(expect.any(String));
        expect(session.createdAt).toEqual(expect.any(String));
        expect(session.expiresAt).toEqual(expect.any(String));
        expect(session.lastUsedAt).toEqual(expect.any(String));
      }
      expect(JSON.stringify(sessions)).not.toMatch(
        /refreshTokenHash|ipHash|passwordHash|\$2[aby]\$/,
      );
    });

    it("never includes a DIFFERENT account's sessions", async () => {
      const emailA = uniqueEmail('list-cross-a');
      const emailB = uniqueEmail('list-cross-b');
      const password = 'correct-horse-battery';

      const registerAResponse = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: emailA, password })
        .expect(HttpStatus.CREATED);
      const registeredA = registerAResponse.body as AuthResponseDto;

      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: emailB, password })
        .expect(HttpStatus.CREATED);

      const listResponse = await request(app.getHttpServer())
        .get('/auth/sessions')
        .set('Authorization', `Bearer ${registeredA.accessToken}`)
        .expect(HttpStatus.OK);

      expect(listResponse.body as SessionSummaryDto[]).toHaveLength(1);
    });

    it('rejects an unauthenticated call with no Authorization header', async () => {
      const response = await request(app.getHttpServer())
        .get('/auth/sessions')
        .expect(HttpStatus.UNAUTHORIZED);

      expect((response.body as ErrorResponseBody).code).toBe(
        'INVALID_ACCESS_TOKEN',
      );
    });
  });

  describe('DELETE /auth/sessions/:id', () => {
    it("revokes the caller's own session, and that session's refresh token stops working", async () => {
      const email = uniqueEmail('revoke-own');
      const password = 'correct-horse-battery';

      const registerResponse = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password })
        .expect(HttpStatus.CREATED);
      const registered = registerResponse.body as AuthResponseDto;

      const listResponse = await request(app.getHttpServer())
        .get('/auth/sessions')
        .set('Authorization', `Bearer ${registered.accessToken}`)
        .expect(HttpStatus.OK);
      const [session] = listResponse.body as SessionSummaryDto[];

      await request(app.getHttpServer())
        .delete(`/auth/sessions/${session.id}`)
        .set('Authorization', `Bearer ${registered.accessToken}`)
        .expect(HttpStatus.NO_CONTENT);

      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: registered.refreshToken })
        .expect(HttpStatus.UNAUTHORIZED);

      const afterListResponse = await request(app.getHttpServer())
        .get('/auth/sessions')
        .set('Authorization', `Bearer ${registered.accessToken}`)
        .expect(HttpStatus.OK);
      expect(afterListResponse.body as SessionSummaryDto[]).toHaveLength(0);

      const auditRows = await prisma.authAuditEvent.findMany({
        where: { userId: registered.user.id, event: 'session_revoked' },
      });
      expect(auditRows).toHaveLength(1);
    });

    /**
     * IDOR-safety: another account's real, currently-active session id must
     * be impossible to revoke — this must return 404, not a distinct
     * "forbidden"/"not yours" response, and must leave the session
     * untouched.
     */
    it("returns 404 for a DIFFERENT account's session id and does NOT revoke it (never a cross-account revoke)", async () => {
      const emailA = uniqueEmail('revoke-cross-a');
      const emailB = uniqueEmail('revoke-cross-b');
      const password = 'correct-horse-battery';

      const registerAResponse = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: emailA, password })
        .expect(HttpStatus.CREATED);
      const registeredA = registerAResponse.body as AuthResponseDto;

      const registerBResponse = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: emailB, password })
        .expect(HttpStatus.CREATED);
      const registeredB = registerBResponse.body as AuthResponseDto;

      const listBResponse = await request(app.getHttpServer())
        .get('/auth/sessions')
        .set('Authorization', `Bearer ${registeredB.accessToken}`)
        .expect(HttpStatus.OK);
      const [sessionB] = listBResponse.body as SessionSummaryDto[];

      const response = await request(app.getHttpServer())
        .delete(`/auth/sessions/${sessionB.id}`)
        .set('Authorization', `Bearer ${registeredA.accessToken}`)
        .expect(HttpStatus.NOT_FOUND);

      expect((response.body as ErrorResponseBody).code).toBe(
        'SESSION_NOT_FOUND',
      );

      // B's session is untouched: B's refresh token still works.
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: registeredB.refreshToken })
        .expect(HttpStatus.OK);
    });

    it('returns 404 for a nonexistent session id', async () => {
      const email = uniqueEmail('revoke-404');
      const password = 'correct-horse-battery';

      const registerResponse = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password })
        .expect(HttpStatus.CREATED);
      const registered = registerResponse.body as AuthResponseDto;

      const response = await request(app.getHttpServer())
        .delete('/auth/sessions/nonexistent-session-id')
        .set('Authorization', `Bearer ${registered.accessToken}`)
        .expect(HttpStatus.NOT_FOUND);

      expect((response.body as ErrorResponseBody).code).toBe(
        'SESSION_NOT_FOUND',
      );
    });

    it('rejects an unauthenticated call with no Authorization header', async () => {
      const response = await request(app.getHttpServer())
        .delete('/auth/sessions/irrelevant-id')
        .expect(HttpStatus.UNAUTHORIZED);

      expect((response.body as ErrorResponseBody).code).toBe(
        'INVALID_ACCESS_TOKEN',
      );
    });
  });

  /**
   * `lastUsedAt` is not just present but ACTUALLY UPDATED at the moment a
   * session is created-or-refreshed — proven end-to-end via `GET
   * /auth/sessions`, not just at the `AuthService` unit level.
   */
  describe('lastUsedAt wiring', () => {
    it('is populated on the fresh session `POST /auth/refresh` creates', async () => {
      const email = uniqueEmail('last-used');
      const password = 'correct-horse-battery';

      const registerResponse = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password })
        .expect(HttpStatus.CREATED);
      const registered = registerResponse.body as AuthResponseDto;

      const beforeRefresh = Date.now();
      const refreshResponse = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: registered.refreshToken })
        .expect(HttpStatus.OK);
      const refreshed = refreshResponse.body as AuthResponseDto;

      const listResponse = await request(app.getHttpServer())
        .get('/auth/sessions')
        .set('Authorization', `Bearer ${refreshed.accessToken}`)
        .expect(HttpStatus.OK);
      const [session] = listResponse.body as SessionSummaryDto[];

      expect(session.lastUsedAt).not.toBeNull();
      expect(new Date(session.lastUsedAt!).getTime()).toBeGreaterThanOrEqual(
        beforeRefresh - 1000,
      );
    });
  });
});
