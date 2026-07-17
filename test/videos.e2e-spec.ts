import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import type { VideoResponseDto } from './../src/videos/video.types';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new AppExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
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
      .get('/videos/video-001')
      .expect(HttpStatus.OK);

    const video = response.body as VideoResponseDto;
    expect(video.id).toBe('video-001');
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

  it('GET /videos/:id/stream returns 206 Partial Content for a Range request', async () => {
    const response = await request(app.getHttpServer())
      .get('/videos/video-001/stream')
      .set('Range', 'bytes=0-1023')
      .expect(HttpStatus.PARTIAL_CONTENT);

    expect(response.headers['content-range']).toMatch(/^bytes 0-1023\/\d+$/);
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['content-type']).toBe('video/mp4');
  });
});
