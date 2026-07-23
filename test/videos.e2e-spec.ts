import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import type { AuthResponseDto } from './../src/auth/auth.types';
import type { VideoResponseDto } from './../src/videos/video.types';

interface ErrorResponseBody {
  statusCode: number;
  code: string;
  message: string;
}

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let accessToken: string;
  let userId: string;

  const emailPrefix = 'videos-e2e-spec+10b3';
  const freeEpisodeId = 'video-104-01';
  const premiumEpisodeId = 'video-104-06';
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
    await prisma.entitlement.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({
      where: { email: { contains: emailPrefix } },
    });
    await app.close();
  });

  it('GET /health returns ok status', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(HttpStatus.OK);

    expect(response.body).toEqual({
      status: 'ok',
      service: 'short-drama-backend',
    });
  });

  it('GET /videos/feed returns at least three videos with a generated playbackUrl and no absolute storage path', async () => {
    const response = await request(app.getHttpServer())
      .get('/videos/feed')
      .expect(HttpStatus.OK);

    const videos = response.body as VideoResponseDto[];
    expect(Array.isArray(videos)).toBe(true);
    expect(videos.length).toBeGreaterThanOrEqual(3);

    const storageRoot = process.env.STORAGE_ROOT;
    const serialized = JSON.stringify(videos);
    if (storageRoot) {
      expect(serialized).not.toContain(storageRoot);
    }

    for (const video of videos) {
      expect(video.playbackUrl).toBe(
        `${process.env.PUBLIC_BASE_URL}/videos/${video.id}/stream`,
      );
      expect(video.hasEmbeddedIndonesianSubtitle).toBe(true);
      expect(video.storageKey.startsWith('/')).toBe(false);
    }
  });

  it('GET /videos/:id returns the matching video', async () => {
    const response = await request(app.getHttpServer())
      .get('/videos/video-104-01')
      .expect(HttpStatus.OK);

    const video = response.body as VideoResponseDto;
    expect(video.id).toBe('video-104-01');
  });

  it('GET /videos/:id returns a structured 404 for an unknown id', async () => {
    const response = await request(app.getHttpServer())
      .get('/videos/does-not-exist')
      .expect(HttpStatus.NOT_FOUND);

    expect(response.body).toEqual({
      statusCode: HttpStatus.NOT_FOUND,
      code: 'VIDEO_NOT_FOUND',
      message: 'Video not found',
    });
  });

  describe('GET /videos/:id/stream (Phase 10, work unit 10-B3)', () => {
    it('returns 401 for an unauthenticated request, even for a free episode', async () => {
      const response = await request(app.getHttpServer())
        .get(`/videos/${freeEpisodeId}/stream`)
        .expect(HttpStatus.UNAUTHORIZED);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('INVALID_ACCESS_TOKEN');
    });

    it('returns 206 Partial Content for an authenticated request to a free episode', async () => {
      const response = await request(app.getHttpServer())
        .get(`/videos/${freeEpisodeId}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Range', 'bytes=0-1023')
        .expect(HttpStatus.PARTIAL_CONTENT);

      expect(response.headers['content-range']).toMatch(/^bytes 0-1023\/\d+$/);
      expect(response.headers['accept-ranges']).toBe('bytes');
      expect(response.headers['content-type']).toBe('video/mp4');
    });

    it('returns 403 ENTITLEMENT_REQUIRED for an authenticated user with no entitlement requesting a premium episode', async () => {
      const response = await request(app.getHttpServer())
        .get(`/videos/${premiumEpisodeId}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.FORBIDDEN);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('ENTITLEMENT_REQUIRED');
    });

    it('returns 206 for a premium episode once the user is granted an entitlement', async () => {
      await prisma.entitlement.create({
        data: { userId, tier: 'premium', source: 'dev-grant' },
      });

      const response = await request(app.getHttpServer())
        .get(`/videos/${premiumEpisodeId}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Range', 'bytes=0-1023')
        .expect(HttpStatus.PARTIAL_CONTENT);

      expect(response.headers['content-range']).toMatch(/^bytes 0-1023\/\d+$/);

      await prisma.entitlement.deleteMany({ where: { userId } });
    });

    it('returns 403 again after the entitlement is revoked', async () => {
      const entitlement = await prisma.entitlement.create({
        data: { userId, tier: 'premium', source: 'dev-grant' },
      });
      await prisma.entitlement.update({
        where: { id: entitlement.id },
        data: { revokedAt: new Date() },
      });

      const response = await request(app.getHttpServer())
        .get(`/videos/${premiumEpisodeId}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.FORBIDDEN);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('ENTITLEMENT_REQUIRED');
    });

    it('returns 403 for an expired entitlement', async () => {
      await prisma.entitlement.create({
        data: {
          userId,
          tier: 'premium',
          source: 'dev-grant',
          expiresAt: new Date(Date.now() - 1000 * 60),
        },
      });

      const response = await request(app.getHttpServer())
        .get(`/videos/${premiumEpisodeId}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.FORBIDDEN);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('ENTITLEMENT_REQUIRED');

      await prisma.entitlement.deleteMany({ where: { userId } });
    });
  });
});
