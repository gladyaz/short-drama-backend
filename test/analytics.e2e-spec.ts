import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import type { AuthResponseDto } from './../src/auth/auth.types';

/**
 * e2e coverage for Phase 11 (work units 11-B3/11-B5/11-B6): analytics
 * ingestion over the real HTTP layer against the real test database, plus
 * the dev-gated /health/details route in its default (disabled) posture.
 */
describe('Analytics (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let accessToken: string;
  let userId: string;

  const emailPrefix = 'analytics-e2e-spec+11b3';

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
        email: `${emailPrefix}-${Date.now()}@example.test`,
        password: 'correct-horse-battery',
      })
      .expect(HttpStatus.CREATED);

    const body = registerResponse.body as AuthResponseDto;
    accessToken = body.accessToken;
    userId = body.user.id;
  });

  afterAll(async () => {
    await prisma.analyticsEvent.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({
      where: { email: { contains: emailPrefix } },
    });
    await app.close();
  });

  it('rejects an unauthenticated ingestion request with 401', async () => {
    await request(app.getHttpServer())
      .post('/analytics/events')
      .send({
        events: [
          {
            eventName: 'feed_view',
            clientTimestamp: new Date().toISOString(),
            platform: 'ios',
          },
        ],
      })
      .expect(HttpStatus.UNAUTHORIZED);
  });

  it('accepts a valid batch and persists sanitized rows', async () => {
    const response = await request(app.getHttpServer())
      .post('/analytics/events')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        events: [
          {
            eventName: 'premium_gate_hit',
            properties: {
              videoId: 'video-104-06',
              seriesId: 'series-104',
              episodeNumber: 6,
              source: 'series-detail',
              email: 'must-be-stripped@example.test',
            },
            clientTimestamp: new Date().toISOString(),
            platform: 'web',
          },
        ],
      })
      .expect(HttpStatus.CREATED);

    expect(response.body).toEqual({ accepted: 1 });

    const row = await prisma.analyticsEvent.findFirstOrThrow({
      where: { userId, eventName: 'premium_gate_hit' },
    });
    expect(row.properties).toEqual({
      videoId: 'video-104-06',
      seriesId: 'series-104',
      episodeNumber: 6,
      source: 'series-detail',
    });
    expect(row.platform).toBe('web');
  });

  it('rejects an unknown event name with 400', async () => {
    await request(app.getHttpServer())
      .post('/analytics/events')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        events: [
          {
            eventName: 'totally_made_up_event',
            clientTimestamp: new Date().toISOString(),
            platform: 'ios',
          },
        ],
      })
      .expect(HttpStatus.BAD_REQUEST);
  });

  it('rejects a calendar-invalid but ISO8601-shaped clientTimestamp with 400, not 500', async () => {
    await request(app.getHttpServer())
      .post('/analytics/events')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        events: [
          {
            eventName: 'feed_view',
            clientTimestamp: '2026-W01',
            platform: 'ios',
          },
        ],
      })
      .expect(HttpStatus.BAD_REQUEST);
  });

  it('rejects a batch above the size cap with 400', async () => {
    const oversized = Array.from({ length: 51 }, () => ({
      eventName: 'feed_view',
      clientTimestamp: new Date().toISOString(),
      platform: 'ios',
    }));

    await request(app.getHttpServer())
      .post('/analytics/events')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ events: oversized })
      .expect(HttpStatus.BAD_REQUEST);
  });

  it('GET /health/details is unreachable (404) with DEV_TOOLS_ENABLED unset', async () => {
    const response = await request(app.getHttpServer())
      .get('/health/details')
      .expect(HttpStatus.NOT_FOUND);

    expect((response.body as { code: string }).code).toBe('DEV_TOOLS_DISABLED');
  });
});
