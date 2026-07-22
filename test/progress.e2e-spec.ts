import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import type { AuthResponseDto } from './../src/auth/auth.types';
import type { ProgressResponseDto } from './../src/progress/progress.types';

interface ErrorResponseBody {
  statusCode: number;
  code: string;
  message: string;
}

/**
 * e2e coverage for the Phase 9 (work unit 9-B2) watch-progress endpoints,
 * hitting the real HTTP layer against the real dev SQLite database, using
 * the app's own seeded video catalog (`video-104-01`, series `series-104`)
 * and a self-cleaning dedicated test user.
 */
describe('Progress (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let accessToken: string;
  let userId: string;

  const emailPrefix = 'progress-e2e-spec+9b2';
  const seededVideoId = 'video-104-01';
  const seededSeriesId = 'series-104';
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

    const registerResponse = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: uniqueEmail('main'), password: 'correct-horse-battery' })
      .expect(HttpStatus.CREATED);

    const body = registerResponse.body as AuthResponseDto;
    accessToken = body.accessToken;
    userId = body.user.id;
  });

  afterAll(async () => {
    await prisma.watchProgress.deleteMany({ where: { userId } });
    await prisma.session.deleteMany({
      where: { user: { email: { contains: emailPrefix } } },
    });
    await prisma.user.deleteMany({
      where: { email: { contains: emailPrefix } },
    });
    await app.close();
  });

  describe('auth guard', () => {
    it('rejects every progress endpoint without an Authorization header', async () => {
      const unauthorized = [
        () =>
          request(app.getHttpServer())
            .put(`/series/${seededSeriesId}/progress`)
            .send({
              videoId: seededVideoId,
              episodeNumber: 1,
              positionSeconds: 0,
            }),
        () => request(app.getHttpServer()).get('/users/me/progress'),
      ];

      for (const makeRequest of unauthorized) {
        const response = await makeRequest().expect(HttpStatus.UNAUTHORIZED);
        expect((response.body as ErrorResponseBody).code).toBe(
          'INVALID_ACCESS_TOKEN',
        );
      }
    });
  });

  describe('PUT /series/:id/progress', () => {
    it('creates progress on first call, then updates it on a second call', async () => {
      const createResponse = await request(app.getHttpServer())
        .put(`/series/${seededSeriesId}/progress`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          videoId: seededVideoId,
          episodeNumber: 1,
          positionSeconds: 15,
          durationSeconds: 300,
        })
        .expect(HttpStatus.OK);

      expect(createResponse.body as ProgressResponseDto).toEqual({
        seriesId: seededSeriesId,
        videoId: seededVideoId,
        episodeNumber: 1,
        positionSeconds: 15,
        durationSeconds: 300,
      });

      const updateResponse = await request(app.getHttpServer())
        .put(`/series/${seededSeriesId}/progress`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          videoId: seededVideoId,
          episodeNumber: 2,
          positionSeconds: 90,
          durationSeconds: 300,
        })
        .expect(HttpStatus.OK);

      expect(updateResponse.body as ProgressResponseDto).toEqual({
        seriesId: seededSeriesId,
        videoId: seededVideoId,
        episodeNumber: 2,
        positionSeconds: 90,
        durationSeconds: 300,
      });

      const rows = await prisma.watchProgress.findMany({
        where: { userId, seriesId: seededSeriesId },
      });
      expect(rows).toHaveLength(1);
    });

    it('rejects with a structured 404 for a nonexistent body videoId', async () => {
      const response = await request(app.getHttpServer())
        .put(`/series/${seededSeriesId}/progress`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          videoId: 'does-not-exist',
          episodeNumber: 1,
          positionSeconds: 0,
        })
        .expect(HttpStatus.NOT_FOUND);

      expect(response.body).toEqual({
        statusCode: HttpStatus.NOT_FOUND,
        code: 'VIDEO_NOT_FOUND',
        message: 'Video not found',
      });
    });
  });

  describe('GET /users/me/progress', () => {
    it('returns the progress rows for the authenticated user', async () => {
      await request(app.getHttpServer())
        .put(`/series/${seededSeriesId}/progress`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          videoId: seededVideoId,
          episodeNumber: 1,
          positionSeconds: 42,
        })
        .expect(HttpStatus.OK);

      const response = await request(app.getHttpServer())
        .get('/users/me/progress')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK);

      // Reuses the same (userId, seriesId) row exercised by the
      // `PUT /series/:id/progress` describe block above; `durationSeconds`
      // is `undefined` in this call's body, which Prisma's `update`
      // interprets as "leave this field unchanged" (not "clear it") — so
      // the value set by the earlier test in this file is retained.
      const rows = response.body as ProgressResponseDto[];
      expect(rows).toContainEqual({
        seriesId: seededSeriesId,
        videoId: seededVideoId,
        episodeNumber: 1,
        positionSeconds: 42,
        durationSeconds: 300,
      });
    });
  });
});
