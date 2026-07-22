import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
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

  const emailPrefix = 'auth-e2e-spec+8b5';
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
  });

  afterAll(async () => {
    await prisma.session.deleteMany({
      where: { user: { email: { contains: emailPrefix } } },
    });
    await prisma.user.deleteMany({
      where: { email: { contains: emailPrefix } },
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
});
