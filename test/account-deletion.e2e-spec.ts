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
 * e2e coverage for Phase 12, work unit 12C-B1 (DECISIONS.md "Phase 12 ...
 * approved..." entry, decision 1): `POST /users/me/deletion`. Hits the real
 * HTTP layer (routing, `JwtAuthGuard`, the dedicated `@Throttle()` override,
 * the global `ValidationPipe`, `AppExceptionFilter`) against the real
 * `PrismaService` connection — which, for the WHOLE e2e run (not just this
 * file), is already redirected to the isolated `DATABASE_URL_TEST` database
 * by `test/jest-e2e.setup.ts`, satisfying this work unit's "deletion tests
 * run only against the isolated test database" requirement without any
 * extra per-file setup. `DEV_TOOLS_ENABLED=true` for the whole file, needed
 * only to bootstrap an admin account via the existing 11B-2 dev-grant route
 * (`POST /dev/admin/grant-role`) for the role-refusal tests below — matches
 * `admin-media.e2e-spec.ts`'s identical precedent. Self-cleaning via
 * `afterAll`.
 */
describe('Account deletion (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let throttlerStorage: ThrottlerStorageService;

  // Kept short deliberately: `@IsEmail()` (via `validator.js`) enforces the
  // RFC 5321 64-character local-part limit, and this prefix is combined with
  // a label + timestamp + random suffix per generated address below (see
  // `auth-rate-limit-lockout.e2e-spec.ts`'s identical precedent).
  const emailPrefix = 'ad-e2e+12cb1';
  // `POST /users/me/deletion` succeeding deliberately emits
  // `account_deletion_success` WITHOUT a `userId` (see
  // `AuthService.deleteAccount`'s doc comment) — the resulting row cannot be
  // found via a `user.email` join afterward, so every deletion request below
  // sets this marker `User-Agent` explicitly (matching
  // `auth-audit.e2e-spec.ts`'s identical precedent) so `afterAll` can still
  // find and remove it.
  const deletionUserAgent = `${emailPrefix}-deletion-agent`;
  const uniqueEmail = (label: string): string =>
    `${emailPrefix}-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

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
    throttlerStorage.storage.clear();
  });

  afterAll(async () => {
    await prisma.authAuditEvent.deleteMany({
      where: { userAgent: { contains: deletionUserAgent } },
    });
    await prisma.authAuditEvent.deleteMany({
      where: { user: { email: { contains: emailPrefix } } },
    });
    await prisma.session.deleteMany({
      where: { user: { email: { contains: emailPrefix } } },
    });
    await prisma.user.deleteMany({
      where: { email: { contains: emailPrefix } },
    });
    await app.close();
    delete process.env.DEV_TOOLS_ENABLED;
  });

  async function registerAccount(
    label: string,
    password = 'correct-horse-battery',
  ): Promise<{ email: string; auth: AuthResponseDto }> {
    const email = uniqueEmail(label);
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(HttpStatus.CREATED);
    return { email, auth: response.body as AuthResponseDto };
  }

  async function grantAdmin(accessToken: string): Promise<void> {
    await request(app.getHttpServer())
      .post('/dev/admin/grant-role')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({})
      .expect(HttpStatus.CREATED);
  }

  it('deletes the account, returns { success: true }, and the account can no longer log in or refresh', async () => {
    const password = 'correct-horse-battery';
    const { email, auth } = await registerAccount('success', password);
    // A second device's session — must also stop working afterward.
    const secondLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(HttpStatus.OK);
    const secondRefreshToken = (secondLogin.body as AuthResponseDto)
      .refreshToken;

    const response = await request(app.getHttpServer())
      .post('/users/me/deletion')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .set('User-Agent', deletionUserAgent)
      .send({ currentPassword: password, confirmDeletion: true })
      .expect(HttpStatus.OK);

    expect(response.body).toEqual({ success: true });

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(HttpStatus.UNAUTHORIZED);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: auth.refreshToken })
      .expect(HttpStatus.UNAUTHORIZED);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: secondRefreshToken })
      .expect(HttpStatus.UNAUTHORIZED);
  });

  it('rejects missing confirmDeletion, confirmDeletion: false, and the string "true" with a clean 400 each, and never deletes the account', async () => {
    const password = 'correct-horse-battery';
    const { email, auth } = await registerAccount(
      'confirm-validation',
      password,
    );

    const missing = await request(app.getHttpServer())
      .post('/users/me/deletion')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .set('User-Agent', deletionUserAgent)
      .send({ currentPassword: password })
      .expect(HttpStatus.BAD_REQUEST);
    expect((missing.body as ErrorResponseBody).code).toBe('HTTP_ERROR');

    const falseValue = await request(app.getHttpServer())
      .post('/users/me/deletion')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .set('User-Agent', deletionUserAgent)
      .send({ currentPassword: password, confirmDeletion: false })
      .expect(HttpStatus.BAD_REQUEST);
    expect((falseValue.body as ErrorResponseBody).code).toBe('HTTP_ERROR');

    const stringTrue = await request(app.getHttpServer())
      .post('/users/me/deletion')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .set('User-Agent', deletionUserAgent)
      .send({ currentPassword: password, confirmDeletion: 'true' })
      .expect(HttpStatus.BAD_REQUEST);
    expect((stringTrue.body as ErrorResponseBody).code).toBe('HTTP_ERROR');

    // The account is untouched by any of the three rejected attempts.
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(HttpStatus.OK);
  });

  it('rejects a wrong current password with the SAME generic body login failures use, and leaves the account intact', async () => {
    const password = 'correct-horse-battery';
    const { email, auth } = await registerAccount('wrong-password', password);

    const response = await request(app.getHttpServer())
      .post('/users/me/deletion')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .set('User-Agent', deletionUserAgent)
      .send({
        currentPassword: 'totally-wrong-password',
        confirmDeletion: true,
      })
      .expect(HttpStatus.UNAUTHORIZED);

    expect(response.body).toEqual(GENERIC_INVALID_CREDENTIALS_BODY);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(HttpStatus.OK);
  });

  it('refuses deletion for a non-"user" role account with 403 ACCOUNT_DELETION_FORBIDDEN, and leaves the account intact', async () => {
    const password = 'correct-horse-battery';
    const { email, auth } = await registerAccount('admin-role', password);
    await grantAdmin(auth.accessToken);

    const response = await request(app.getHttpServer())
      .post('/users/me/deletion')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .set('User-Agent', deletionUserAgent)
      .send({ currentPassword: password, confirmDeletion: true })
      .expect(HttpStatus.FORBIDDEN);

    expect((response.body as ErrorResponseBody).code).toBe(
      'ACCOUNT_DELETION_FORBIDDEN',
    );

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(HttpStatus.OK);
  });

  it('order-of-checks: an admin account with a WRONG password gets 401 INVALID_CREDENTIALS, not 403 ACCOUNT_DELETION_FORBIDDEN', async () => {
    const password = 'correct-horse-battery';
    const { auth } = await registerAccount('order-of-checks', password);
    await grantAdmin(auth.accessToken);

    const response = await request(app.getHttpServer())
      .post('/users/me/deletion')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .set('User-Agent', deletionUserAgent)
      .send({
        currentPassword: 'totally-wrong-password',
        confirmDeletion: true,
      })
      .expect(HttpStatus.UNAUTHORIZED);

    expect(response.body).toEqual(GENERIC_INVALID_CREDENTIALS_BODY);
  });

  it('is idempotent: a second deletion call with the same access token returns a clean 401, never a 500', async () => {
    const password = 'correct-horse-battery';
    const { auth } = await registerAccount('idempotent', password);

    await request(app.getHttpServer())
      .post('/users/me/deletion')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .set('User-Agent', deletionUserAgent)
      .send({ currentPassword: password, confirmDeletion: true })
      .expect(HttpStatus.OK);

    const secondCall = await request(app.getHttpServer())
      .post('/users/me/deletion')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .set('User-Agent', deletionUserAgent)
      .send({ currentPassword: password, confirmDeletion: true })
      .expect(HttpStatus.UNAUTHORIZED);

    expect((secondCall.body as ErrorResponseBody).code).toBe(
      'INVALID_ACCESS_TOKEN',
    );
  });

  it('rejects an unauthenticated call with no Authorization header', async () => {
    const response = await request(app.getHttpServer())
      .post('/users/me/deletion')
      .send({ currentPassword: 'whatever', confirmDeletion: true })
      .expect(HttpStatus.UNAUTHORIZED);

    expect((response.body as ErrorResponseBody).code).toBe(
      'INVALID_ACCESS_TOKEN',
    );
  });

  it('IDOR sanity: deleting one account never touches a different account', async () => {
    const password = 'correct-horse-battery';
    const { auth: authA } = await registerAccount('idor-a', password);
    const { email: emailB, auth: authB } = await registerAccount(
      'idor-b',
      password,
    );

    await request(app.getHttpServer())
      .post('/users/me/deletion')
      .set('Authorization', `Bearer ${authA.accessToken}`)
      .set('User-Agent', deletionUserAgent)
      .send({ currentPassword: password, confirmDeletion: true })
      .expect(HttpStatus.OK);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: emailB, password })
      .expect(HttpStatus.OK);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: authB.refreshToken })
      .expect(HttpStatus.OK);
  });

  it('returns a generic 429 on the 6th deletion call within the window (limit 5/15min)', async () => {
    const password = 'correct-horse-battery';
    const { email, auth } = await registerAccount('rate-limit', password);

    const attemptDeletion = () =>
      request(app.getHttpServer())
        .post('/users/me/deletion')
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .set('User-Agent', deletionUserAgent)
        .send({
          currentPassword: 'totally-wrong-password',
          confirmDeletion: true,
        });

    for (let i = 0; i < 5; i += 1) {
      await attemptDeletion().expect(HttpStatus.UNAUTHORIZED);
    }

    const blocked = await attemptDeletion().expect(
      HttpStatus.TOO_MANY_REQUESTS,
    );
    expect((blocked.body as ErrorResponseBody).statusCode).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );

    // Every attempt used the wrong password, so the account is untouched.
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(HttpStatus.OK);
  });
});
