import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import type { AuthResponseDto } from './../src/auth/auth.types';
import { e2eSuiteBootBudgetMs } from './../src/common/testing/e2e-boot-budget.helpers';

/**
 * e2e coverage for Phase 12, work unit 12A-B2 (DECISIONS.md decision 8):
 * `helmet()` defaults + the explicit 256kb JSON body-parser limit. Every
 * other e2e spec in this suite builds its own `INestApplication` rather
 * than reusing `src/main.ts`'s `bootstrap()` (which only runs for the real
 * server process, never for `Test.createTestingModule`), so this spec
 * mirrors `main.ts`'s exact `helmet()` + `bodyParser: false` +
 * `useBodyParser('json'|'urlencoded', { limit: JSON_BODY_LIMIT })` setup
 * to actually exercise the production configuration end to end, not just
 * `AppModule`'s own guards/pipes.
 */
describe('Security headers + JSON body limit (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let accessToken: string;
  let userId: string;

  const emailPrefix = 'security-headers-e2e-spec+12a-b2';
  // Mirrors src/main.ts's JSON_BODY_LIMIT constant — kept as a literal here
  // (rather than importing main.ts, which would re-run bootstrap()'s
  // process-level side effects) but must stay numerically identical to it.
  const JSON_BODY_LIMIT_BYTES = 256 * 1024;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    app.use(helmet());
    app.useBodyParser('json', { limit: '256kb' });
    app.useBodyParser('urlencoded', { extended: true, limit: '256kb' });
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
        email: `${emailPrefix}-${Date.now()}@example.test`,
        password: 'correct-horse-battery',
      })
      .expect(HttpStatus.CREATED);

    const body = registerResponse.body as AuthResponseDto;
    accessToken = body.accessToken;
    userId = body.user.id;
  }, e2eSuiteBootBudgetMs(1));

  afterAll(async () => {
    await prisma.analyticsEvent.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({
      where: { email: { contains: emailPrefix } },
    });
    await app.close();
  });

  describe('helmet security headers', () => {
    it('sets X-Content-Type-Options: nosniff on a plain GET response', async () => {
      const response = await request(app.getHttpServer())
        .get('/health')
        .expect(HttpStatus.OK);

      expect(response.headers['x-content-type-options']).toBe('nosniff');
    });

    it('sets a Strict-Transport-Security (HSTS) header', async () => {
      const response = await request(app.getHttpServer())
        .get('/health')
        .expect(HttpStatus.OK);

      expect(response.headers['strict-transport-security']).toBeDefined();
      expect(response.headers['strict-transport-security']).toContain(
        'max-age=',
      );
    });

    it('sets an X-Frame-Options / frameguard header', async () => {
      const response = await request(app.getHttpServer())
        .get('/health')
        .expect(HttpStatus.OK);

      expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    });

    it('does not expose the X-Powered-By header', async () => {
      const response = await request(app.getHttpServer())
        .get('/health')
        .expect(HttpStatus.OK);

      expect(response.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('256kb JSON body limit', () => {
    it('rejects a JSON body larger than 256kb with 413', async () => {
      // Deliberately not a valid AnalyticsEventInputDto shape — the
      // body-parser byte-size rejection happens in middleware before Nest's
      // routing/validation pipeline ever inspects the payload, so an
      // oversized-but-otherwise-arbitrary JSON body is sufficient to prove
      // the limit is enforced.
      const oversizedPayload = {
        padding: 'x'.repeat(JSON_BODY_LIMIT_BYTES + 1024),
      };

      await request(app.getHttpServer())
        .post('/analytics/events')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(oversizedPayload)
        .expect(HttpStatus.PAYLOAD_TOO_LARGE);
    });

    it('accepts a normal, well-under-the-limit request', async () => {
      const response = await request(app.getHttpServer())
        .post('/analytics/events')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          events: [
            {
              eventName: 'feed_view',
              clientTimestamp: new Date().toISOString(),
              platform: 'ios',
            },
          ],
        })
        .expect(HttpStatus.CREATED);

      expect(response.body).toEqual({ accepted: 1 });
    });

    it('accepts the largest legitimate real body — a full 50-event analytics batch with max-length string properties — comfortably under 256kb', async () => {
      // MAX_BATCH_SIZE (50) and MAX_PROPERTY_STRING_LENGTH (2000) from
      // src/analytics/analytics.types.ts: the largest body any legitimate
      // client can construct against this endpoint's own validated shape.
      // Measured at ~204KB, ~52KB of headroom under the 256kb ceiling.
      const longString = 'x'.repeat(2000);
      const events = Array.from({ length: 50 }, () => ({
        eventName: 'app_error',
        properties: {
          message: longString,
          stack: longString,
          isFatal: true,
          source: 'GlobalErrorHandler',
        },
        clientTimestamp: new Date().toISOString(),
        platform: 'ios',
      }));

      const payload = JSON.stringify({ events });
      expect(Buffer.byteLength(payload, 'utf8')).toBeLessThan(
        JSON_BODY_LIMIT_BYTES,
      );

      const response = await request(app.getHttpServer())
        .post('/analytics/events')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Content-Type', 'application/json')
        .send(payload)
        .expect(HttpStatus.CREATED);

      expect(response.body).toEqual({ accepted: 50 });
    });
  });
});
