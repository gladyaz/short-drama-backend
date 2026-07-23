import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import type { AuthResponseDto } from './../src/auth/auth.types';
import type { EntitlementStatusDto } from './../src/entitlements/entitlement.types';

interface ErrorResponseBody {
  statusCode: number;
  code: string;
  message: string;
}

/**
 * e2e coverage for the Phase 10 (work units 10-B4/10-B5/10-B6) entitlement
 * endpoints, hitting the real HTTP layer against the real test database.
 * Split into two apps because `DEV_TOOLS_ENABLED` is read once at
 * `ConfigModule` bootstrap (see `src/config/configuration.ts`) — the first
 * app models the default/production-safe posture (flag unset, matching this
 * repo's real `.env`), the second explicitly opts in to exercise the
 * dev-only grant/revoke routes end-to-end.
 */
describe('Entitlements (e2e)', () => {
  const emailPrefix = 'entitlements-e2e-spec+10b4';
  const uniqueEmail = (label: string): string =>
    `${emailPrefix}-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  describe('with DEV_TOOLS_ENABLED unset (default, production-safe posture)', () => {
    let app: INestApplication<App>;
    let prisma: PrismaService;
    let accessToken: string;
    let userId: string;

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

      const registerResponse = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: uniqueEmail('default'),
          password: 'correct-horse-battery',
        })
        .expect(HttpStatus.CREATED);

      const body = registerResponse.body as AuthResponseDto;
      accessToken = body.accessToken;
      userId = body.user.id;
    });

    afterAll(async () => {
      await prisma.entitlement.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({
        where: { email: { contains: emailPrefix } },
      });
      await app.close();
    });

    it('GET /users/me/entitlement returns 401 without a token', async () => {
      await request(app.getHttpServer())
        .get('/users/me/entitlement')
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('GET /users/me/entitlement returns isPremium:false for a fresh user', async () => {
      const response = await request(app.getHttpServer())
        .get('/users/me/entitlement')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK);

      const body = response.body as EntitlementStatusDto;
      expect(body).toEqual({ isPremium: false, expiresAt: null });
    });

    it('POST /dev/entitlements/grant returns 404 DEV_TOOLS_DISABLED', async () => {
      const response = await request(app.getHttpServer())
        .post('/dev/entitlements/grant')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(HttpStatus.NOT_FOUND);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('DEV_TOOLS_DISABLED');
    });

    it('POST /dev/entitlements/revoke returns 404 DEV_TOOLS_DISABLED', async () => {
      const response = await request(app.getHttpServer())
        .post('/dev/entitlements/revoke')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(HttpStatus.NOT_FOUND);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('DEV_TOOLS_DISABLED');
    });
  });

  describe('with DEV_TOOLS_ENABLED=true (developer opt-in)', () => {
    let app: INestApplication<App>;
    let prisma: PrismaService;
    let accessToken: string;
    let userId: string;
    let otherAccessToken: string;
    let otherUserId: string;

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

      const registerResponse = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: uniqueEmail('enabled'),
          password: 'correct-horse-battery',
        })
        .expect(HttpStatus.CREATED);
      const body = registerResponse.body as AuthResponseDto;
      accessToken = body.accessToken;
      userId = body.user.id;

      const otherRegisterResponse = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: uniqueEmail('other'),
          password: 'correct-horse-battery',
        })
        .expect(HttpStatus.CREATED);
      const otherBody = otherRegisterResponse.body as AuthResponseDto;
      otherAccessToken = otherBody.accessToken;
      otherUserId = otherBody.user.id;
    });

    afterAll(async () => {
      await prisma.entitlement.deleteMany({ where: { userId } });
      await prisma.entitlement.deleteMany({ where: { userId: otherUserId } });
      await prisma.user.deleteMany({
        where: { email: { contains: emailPrefix } },
      });
      await app.close();
      delete process.env.DEV_TOOLS_ENABLED;
    });

    it('grants and reflects premium status', async () => {
      await request(app.getHttpServer())
        .post('/dev/entitlements/grant')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(HttpStatus.CREATED);

      const status = await request(app.getHttpServer())
        .get('/users/me/entitlement')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK);

      expect((status.body as EntitlementStatusDto).isPremium).toBe(true);
    });

    it('revokes and reflects non-premium status', async () => {
      await request(app.getHttpServer())
        .post('/dev/entitlements/revoke')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(HttpStatus.CREATED);

      const status = await request(app.getHttpServer())
        .get('/users/me/entitlement')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK);

      expect((status.body as EntitlementStatusDto).isPremium).toBe(false);
    });

    it('granting one user does not entitle another user', async () => {
      await request(app.getHttpServer())
        .post('/dev/entitlements/grant')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(HttpStatus.CREATED);

      const otherStatus = await request(app.getHttpServer())
        .get('/users/me/entitlement')
        .set('Authorization', `Bearer ${otherAccessToken}`)
        .expect(HttpStatus.OK);

      expect((otherStatus.body as EntitlementStatusDto).isPremium).toBe(false);

      await prisma.entitlement.deleteMany({ where: { userId } });
    });

    it('supports granting a specific targetUserId', async () => {
      await request(app.getHttpServer())
        .post('/dev/entitlements/grant')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ targetUserId: otherUserId })
        .expect(HttpStatus.CREATED);

      const otherStatus = await request(app.getHttpServer())
        .get('/users/me/entitlement')
        .set('Authorization', `Bearer ${otherAccessToken}`)
        .expect(HttpStatus.OK);

      expect((otherStatus.body as EntitlementStatusDto).isPremium).toBe(true);

      await prisma.entitlement.deleteMany({ where: { userId: otherUserId } });
    });
  });
});
