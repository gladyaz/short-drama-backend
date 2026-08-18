import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import type { AuthResponseDto } from './../src/auth/auth.types';
import type { AdminRoleStatusDto } from './../src/admin/admin.types';
import { e2eSuiteBootBudgetMs } from './../src/common/testing/e2e-boot-budget.helpers';

interface ErrorResponseBody {
  statusCode: number;
  code: string;
  message: string;
}

/**
 * e2e coverage for the Phase 11 (work unit 11B-2) admin role + `AdminGuard`
 * endpoints, hitting the real HTTP layer against the real test database.
 * Split into two describe blocks for the same reason as
 * `entitlements.e2e-spec.ts`: `DEV_TOOLS_ENABLED` is read once at
 * `ConfigModule` bootstrap, so the default/production-safe posture (flag
 * unset) and the developer opt-in posture need separate app instances.
 */
describe('Admin (e2e)', () => {
  const emailPrefix = 'admin-e2e-spec+11b2';
  const uniqueEmail = (label: string): string =>
    `${emailPrefix}-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  describe('with DEV_TOOLS_ENABLED unset (default, production-safe posture)', () => {
    let app: INestApplication<App>;
    let prisma: PrismaService;
    let accessToken: string;

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
    }, e2eSuiteBootBudgetMs(1));

    afterAll(async () => {
      await prisma.user.deleteMany({
        where: { email: { contains: emailPrefix } },
      });
      await app.close();
    });

    it('GET /admin/whoami returns 401 without a token', async () => {
      await request(app.getHttpServer())
        .get('/admin/whoami')
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('GET /admin/whoami returns 403 ADMIN_ROLE_REQUIRED for a non-admin user', async () => {
      const response = await request(app.getHttpServer())
        .get('/admin/whoami')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.FORBIDDEN);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('ADMIN_ROLE_REQUIRED');
    });

    it('POST /dev/admin/grant-role returns 404 DEV_TOOLS_DISABLED', async () => {
      const response = await request(app.getHttpServer())
        .post('/dev/admin/grant-role')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(HttpStatus.NOT_FOUND);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('DEV_TOOLS_DISABLED');
    });

    it('POST /dev/admin/revoke-role returns 404 DEV_TOOLS_DISABLED', async () => {
      const response = await request(app.getHttpServer())
        .post('/dev/admin/revoke-role')
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
    }, e2eSuiteBootBudgetMs(2));

    afterAll(async () => {
      await prisma.user.deleteMany({
        where: { email: { contains: emailPrefix } },
      });
      await app.close();
      delete process.env.DEV_TOOLS_ENABLED;
    });

    it('grants the admin role and AdminGuard then allows /admin/whoami', async () => {
      const grantResponse = await request(app.getHttpServer())
        .post('/dev/admin/grant-role')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(HttpStatus.CREATED);

      const grantBody = grantResponse.body as AdminRoleStatusDto;
      expect(grantBody.role).toBe('admin');

      const whoamiResponse = await request(app.getHttpServer())
        .get('/admin/whoami')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK);

      const whoamiBody = whoamiResponse.body as AdminRoleStatusDto;
      expect(whoamiBody.role).toBe('admin');
    });

    it('revokes the admin role and AdminGuard then rejects /admin/whoami again', async () => {
      await request(app.getHttpServer())
        .post('/dev/admin/revoke-role')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(HttpStatus.CREATED);

      const response = await request(app.getHttpServer())
        .get('/admin/whoami')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.FORBIDDEN);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('ADMIN_ROLE_REQUIRED');
    });

    it('granting admin to one user does not grant it to another', async () => {
      await request(app.getHttpServer())
        .post('/dev/admin/grant-role')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(HttpStatus.CREATED);

      await request(app.getHttpServer())
        .get('/admin/whoami')
        .set('Authorization', `Bearer ${otherAccessToken}`)
        .expect(HttpStatus.FORBIDDEN);

      await request(app.getHttpServer())
        .post('/dev/admin/revoke-role')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(HttpStatus.CREATED);
    });

    it('supports granting a specific targetUserId', async () => {
      await request(app.getHttpServer())
        .post('/dev/admin/grant-role')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ targetUserId: otherUserId })
        .expect(HttpStatus.CREATED);

      await request(app.getHttpServer())
        .get('/admin/whoami')
        .set('Authorization', `Bearer ${otherAccessToken}`)
        .expect(HttpStatus.OK);

      await request(app.getHttpServer())
        .post('/dev/admin/revoke-role')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ targetUserId: otherUserId })
        .expect(HttpStatus.CREATED);
    });
  });
});
