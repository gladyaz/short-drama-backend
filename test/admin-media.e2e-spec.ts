import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { StorageService } from './../src/storage/storage.service';
import type { AuthResponseDto } from './../src/auth/auth.types';
import type { AdminMediaDto } from './../src/media/media.types';

interface ErrorResponseBody {
  statusCode: number;
  code: string;
  message: string;
}

interface CreateUploadResponseBody {
  media: { id: string; lifecycleState: string; objectStorageKey: string };
  upload: { url: string; key: string; expiresAt: string };
}

/**
 * e2e coverage for the Phase 11 (work unit 11B-3) admin-guarded
 * `/admin/media` upload/publish API, hitting the real HTTP layer against
 * the real test database. `StorageService` is overridden with a jest mock
 * for the entire suite — no test here makes a real R2/S3 call.
 * `DEV_TOOLS_ENABLED=true` for the whole file, needed only to bootstrap an
 * admin user via the 11B-2 dev-grant route (a real admin-provisioning flow
 * does not exist yet).
 */
describe('Admin Media (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminAccessToken: string;
  let nonAdminAccessToken: string;
  let mockStorageService: {
    createPresignedPutUrl: jest.Mock;
    createPresignedGetUrl: jest.Mock;
    headObject: jest.Mock;
    objectExists: jest.Mock;
    deleteObject: jest.Mock;
    buildPublicUrl: jest.Mock;
  };

  const emailPrefix = 'admin-media-e2e-spec+11b3';
  const testSeriesId = `${emailPrefix}-series`;
  const uniqueEmail = (label: string): string =>
    `${emailPrefix}-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  const validCreateBody = {
    seriesId: testSeriesId,
    title: 'E2E Admin Media',
    episodeNumber: 1,
    channelName: 'E2E Channel',
    caption: 'E2E caption',
    category: 'drama',
    sourceLanguage: 'zh',
    hasEmbeddedIndonesianSubtitle: true,
  };

  beforeAll(async () => {
    process.env.DEV_TOOLS_ENABLED = 'true';

    mockStorageService = {
      createPresignedPutUrl: jest.fn().mockResolvedValue({
        url: 'https://signed.example.test/put',
        key: 'admin-media/mock/source',
        expiresAt: new Date(Date.now() + 60_000),
      }),
      createPresignedGetUrl: jest.fn(),
      headObject: jest.fn(),
      objectExists: jest.fn().mockResolvedValue(true),
      deleteObject: jest.fn(),
      buildPublicUrl: jest.fn(),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(StorageService)
      .useValue(mockStorageService)
      .compile();

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

    const adminRegister = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: uniqueEmail('admin'), password: 'correct-horse-battery' })
      .expect(HttpStatus.CREATED);
    adminAccessToken = (adminRegister.body as AuthResponseDto).accessToken;

    await request(app.getHttpServer())
      .post('/dev/admin/grant-role')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({})
      .expect(HttpStatus.CREATED);

    const userRegister = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: uniqueEmail('user'), password: 'correct-horse-battery' })
      .expect(HttpStatus.CREATED);
    nonAdminAccessToken = (userRegister.body as AuthResponseDto).accessToken;
  });

  afterAll(async () => {
    await prisma.video.deleteMany({ where: { seriesId: testSeriesId } });
    await prisma.user.deleteMany({
      where: { email: { contains: emailPrefix } },
    });
    await app.close();
    delete process.env.DEV_TOOLS_ENABLED;
  });

  beforeEach(() => {
    mockStorageService.createPresignedPutUrl.mockClear();
    mockStorageService.objectExists.mockClear();
  });

  describe('401 — no token', () => {
    it('POST /admin/media returns 401 without a token', async () => {
      await request(app.getHttpServer())
        .post('/admin/media')
        .send(validCreateBody)
        .expect(HttpStatus.UNAUTHORIZED);
    });
  });

  describe('403 — authenticated but not an admin', () => {
    it('POST /admin/media returns 403 ADMIN_ROLE_REQUIRED for a non-admin user', async () => {
      const response = await request(app.getHttpServer())
        .post('/admin/media')
        .set('Authorization', `Bearer ${nonAdminAccessToken}`)
        .send(validCreateBody)
        .expect(HttpStatus.FORBIDDEN);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('ADMIN_ROLE_REQUIRED');
    });
  });

  describe('400 — metadata validation', () => {
    it('POST /admin/media returns 400 when a required field is missing', async () => {
      const { title: _title, ...missingTitle } = validCreateBody;
      void _title;

      const response = await request(app.getHttpServer())
        .post('/admin/media')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send(missingTitle)
        .expect(HttpStatus.BAD_REQUEST);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('HTTP_ERROR');
    });

    it('POST /admin/media returns 400 for a non-whitelisted extra field', async () => {
      await request(app.getHttpServer())
        .post('/admin/media')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ ...validCreateBody, notARealField: 'nope' })
        .expect(HttpStatus.BAD_REQUEST);
    });

    it('POST /admin/media returns 400 for a wrong-typed field (episodeNumber as a string)', async () => {
      await request(app.getHttpServer())
        .post('/admin/media')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ ...validCreateBody, episodeNumber: 'not-a-number' })
        .expect(HttpStatus.BAD_REQUEST);
    });
  });

  describe('admin happy path', () => {
    let mediaId: string;

    it('creates a draft upload via the mocked StorageService, never a real network call', async () => {
      const response = await request(app.getHttpServer())
        .post('/admin/media')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ ...validCreateBody, contentType: 'video/mp4' })
        .expect(HttpStatus.CREATED);

      const body = response.body as CreateUploadResponseBody;
      mediaId = body.media.id;

      expect(body.media.lifecycleState).toBe('draft');
      expect(body.upload.url).toBe('https://signed.example.test/put');
      expect(mockStorageService.createPresignedPutUrl).toHaveBeenCalledTimes(1);
    });

    it('GET /admin/media/:id returns the admin view of the draft', async () => {
      const response = await request(app.getHttpServer())
        .get(`/admin/media/${mediaId}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.OK);

      expect((response.body as AdminMediaDto).lifecycleState).toBe('draft');
    });

    it('the draft is invisible to the public feed and GET /videos/:id', async () => {
      const feedResponse = await request(app.getHttpServer())
        .get('/videos/feed')
        .expect(HttpStatus.OK);
      const feedIds = (feedResponse.body as Array<{ id: string }>).map(
        (v) => v.id,
      );
      expect(feedIds).not.toContain(mediaId);

      await request(app.getHttpServer())
        .get(`/videos/${mediaId}`)
        .expect(HttpStatus.NOT_FOUND);
    });

    it('completes the upload (draft -> ready) once the mocked StorageService confirms the object exists', async () => {
      const response = await request(app.getHttpServer())
        .post(`/admin/media/${mediaId}/complete-upload`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ durationSeconds: 90, width: 1080, height: 1920 })
        .expect(HttpStatus.OK);

      const body = response.body as AdminMediaDto;
      expect(body.lifecycleState).toBe('ready');
      expect(body.durationSeconds).toBe(90);
    });

    it('uploads a cover and a thumbnail', async () => {
      const coverResponse = await request(app.getHttpServer())
        .post(`/admin/media/${mediaId}/cover`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ contentType: 'image/jpeg' })
        .expect(HttpStatus.CREATED);
      expect(
        (coverResponse.body as CreateUploadResponseBody).media.objectStorageKey,
      ).toBeDefined();

      const thumbnailResponse = await request(app.getHttpServer())
        .post(`/admin/media/${mediaId}/thumbnail`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({})
        .expect(HttpStatus.CREATED);
      expect(thumbnailResponse.body).toBeDefined();
    });

    it('publishes the media (ready -> published), then it appears in the public feed', async () => {
      const response = await request(app.getHttpServer())
        .post(`/admin/media/${mediaId}/publish`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({})
        .expect(HttpStatus.OK);

      expect((response.body as AdminMediaDto).lifecycleState).toBe('published');

      const feedResponse = await request(app.getHttpServer())
        .get('/videos/feed')
        .expect(HttpStatus.OK);
      const feedIds = (feedResponse.body as Array<{ id: string }>).map(
        (v) => v.id,
      );
      expect(feedIds).toContain(mediaId);
    });

    it('unpublishes the media (published -> unpublished), then it disappears from the feed again', async () => {
      await request(app.getHttpServer())
        .post(`/admin/media/${mediaId}/unpublish`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({})
        .expect(HttpStatus.OK);

      const feedResponse = await request(app.getHttpServer())
        .get('/videos/feed')
        .expect(HttpStatus.OK);
      const feedIds = (feedResponse.body as Array<{ id: string }>).map(
        (v) => v.id,
      );
      expect(feedIds).not.toContain(mediaId);
    });

    it('rejects an invalid transition (publish again immediately) with a clean 400', async () => {
      const response = await request(app.getHttpServer())
        .post(`/admin/media/${mediaId}/publish`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({})
        .expect(HttpStatus.OK); // unpublished -> published is allowed

      expect((response.body as AdminMediaDto).lifecycleState).toBe('published');

      // publishing an already-published record is not a valid edge.
      const invalidResponse = await request(app.getHttpServer())
        .post(`/admin/media/${mediaId}/publish`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({})
        .expect(HttpStatus.BAD_REQUEST);

      const body = invalidResponse.body as ErrorResponseBody;
      expect(body.code).toBe('INVALID_MEDIA_LIFECYCLE_TRANSITION');
    });

    it('returns 404 VIDEO_NOT_FOUND for an unknown media id', async () => {
      const response = await request(app.getHttpServer())
        .get('/admin/media/does-not-exist')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.NOT_FOUND);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('VIDEO_NOT_FOUND');
    });
  });
});
