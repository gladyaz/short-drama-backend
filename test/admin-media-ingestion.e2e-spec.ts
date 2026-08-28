import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { StorageService } from './../src/storage/storage.service';
import type { AuthResponseDto } from './../src/auth/auth.types';
import type {
  AdminMediaDto,
  AdminMediaStatusDto,
} from './../src/media/media.types';
import { e2eSuiteBootBudgetMs } from './../src/common/testing/e2e-boot-budget.helpers';

interface ErrorResponseBody {
  statusCode: number;
  code: string;
  message: string;
}

interface CreateUploadResponseBody {
  media: AdminMediaDto;
  upload: { url: string; key: string; expiresAt: string };
}

/**
 * Work unit "ADMIN MEDIA INGESTION": e2e coverage for the two routes this
 * work unit adds to the admin ingestion API — `GET /admin/media/:id/status`
 * and `POST /admin/media/:id/retry-transcode` — plus the direct-to-R2
 * authorization contract and the hardened zero-byte completion check, all
 * exercised through the real HTTP layer against the real test database.
 *
 * Kept as its OWN file rather than extended onto `admin-media.e2e-spec.ts`,
 * matching this repo's existing "new slice gets its own spec file" precedent
 * (`admin-media-transcode.spec.ts` beside `admin-media.service.spec.ts`), so
 * the pre-existing suite stays completely unmodified.
 *
 * `StorageService` is overridden with a jest mock for the entire suite: no
 * test here makes a real R2/S3 call, and nothing in this file ever mutates a
 * real object.
 *
 * NOTE ON `TRANSCODE_ENABLED`. This suite runs with the flag OFF (the
 * shipped default, and what `AppModule` boots with here), so the retry route
 * is exercised for its AUTHORIZATION and REFUSAL contract. The flag-on
 * behaviors — the version bump, the exactly-once compare-and-swap, and the
 * enqueue itself — are proven at the service level in
 * `src/media/admin-media-ingestion.spec.ts`, which can wire a mocked queue
 * without booting the whole app against a Redis-backed module.
 */
describe('Admin Media Ingestion (e2e)', () => {
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

  const emailPrefix = 'admin-media-ingestion-e2e';
  const testSeriesId = `${emailPrefix}-series`;
  const uploadSizeBytes = 1024;
  const uniqueEmail = (label: string): string =>
    `${emailPrefix}-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  let episodeCounter = 0;
  const nextCreateBody = (): Record<string, unknown> => ({
    seriesId: testSeriesId,
    title: 'Ingestion E2E Media',
    episodeNumber: ++episodeCounter,
    channelName: 'E2E Channel',
    caption: 'E2E caption',
    category: 'drama',
    sourceLanguage: 'zh',
    hasEmbeddedIndonesianSubtitle: true,
    sizeBytes: uploadSizeBytes,
    contentType: 'video/mp4',
  });

  beforeAll(async () => {
    process.env.DEV_TOOLS_ENABLED = 'true';

    mockStorageService = {
      // Echoes back the key it was handed, exactly as the real
      // `StorageService.createPresignedPutUrl` does — so the assertions
      // below can check the SERVER-DERIVED key that actually reaches
      // storage, rather than a fixed literal the mock invented.
      createPresignedPutUrl: jest.fn().mockImplementation((key: string) =>
        Promise.resolve({
          url: `https://signed.example.test/put/${key}?X-Amz-Signature=deadbeef`,
          key,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ),
      createPresignedGetUrl: jest.fn(),
      headObject: jest.fn().mockResolvedValue({
        key: 'admin-media/mock/source',
        contentLength: uploadSizeBytes,
        contentType: 'video/mp4',
      }),
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
  }, e2eSuiteBootBudgetMs(2));

  afterAll(async () => {
    await prisma.video.deleteMany({
      where: { seriesId: { startsWith: testSeriesId } },
    });
    await prisma.user.deleteMany({
      where: { email: { contains: emailPrefix } },
    });
    await app.close();
    delete process.env.DEV_TOOLS_ENABLED;
  });

  beforeEach(() => {
    mockStorageService.createPresignedPutUrl.mockClear();
    mockStorageService.headObject.mockClear();
    mockStorageService.headObject.mockResolvedValue({
      key: 'admin-media/mock/source',
      contentLength: uploadSizeBytes,
      contentType: 'video/mp4',
    });
  });

  /** Creates a draft via the real HTTP route and returns the response body. */
  async function createDraft(): Promise<CreateUploadResponseBody> {
    const response = await request(app.getHttpServer())
      .post('/admin/media')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send(nextCreateBody())
      .expect(HttpStatus.CREATED);

    return response.body as CreateUploadResponseBody;
  }

  async function createReadyMedia(): Promise<string> {
    const created = await createDraft();
    await request(app.getHttpServer())
      .post(`/admin/media/${created.media.id}/complete-upload`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({})
      .expect(HttpStatus.OK);
    return created.media.id;
  }

  describe('direct-to-R2 upload authorization', () => {
    // The whole architectural point: the API hands back an authorization to
    // PUT somewhere, and the bytes never traverse this server.
    it('returns a presigned PUT URL and a server-derived key, and streams no bytes through the API', async () => {
      const body = await createDraft();

      expect(body.upload.url).toContain('https://');
      expect(body.upload.key).toBe(`admin-media/${body.media.id}/source`);
      expect(body.media.objectStorageKey).toBe(
        `admin-media/${body.media.id}/source`,
      );
      // The key is derived from the server-minted id — the client never
      // supplied, and cannot influence, the object key or the bucket.
      expect(mockStorageService.createPresignedPutUrl).toHaveBeenCalledTimes(1);
      const [keyArg, optionsArg] = mockStorageService.createPresignedPutUrl.mock
        .calls[0] as [string, { contentType?: string } | undefined];
      expect(keyArg).toBe(`admin-media/${body.media.id}/source`);
      expect(optionsArg).toEqual({ contentType: 'video/mp4' });
    });

    it('rejects a client-supplied object key as a non-whitelisted field', async () => {
      await request(app.getHttpServer())
        .post('/admin/media')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          ...nextCreateBody(),
          objectStorageKey: 'admin-media/media-someone-else/source',
        })
        .expect(HttpStatus.BAD_REQUEST);
    });
  });

  describe('GET /admin/media/:id/status', () => {
    it('returns 401 without a token', async () => {
      const id = (await createDraft()).media.id;

      await request(app.getHttpServer())
        .get(`/admin/media/${id}/status`)
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('returns 403 ADMIN_ROLE_REQUIRED for an authenticated non-admin', async () => {
      const id = (await createDraft()).media.id;

      const response = await request(app.getHttpServer())
        .get(`/admin/media/${id}/status`)
        .set('Authorization', `Bearer ${nonAdminAccessToken}`)
        .expect(HttpStatus.FORBIDDEN);

      expect((response.body as ErrorResponseBody).code).toBe(
        'ADMIN_ROLE_REQUIRED',
      );
    });

    it('returns 404 for an unknown media id', async () => {
      const response = await request(app.getHttpServer())
        .get('/admin/media/media-does-not-exist/status')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.NOT_FOUND);

      expect((response.body as ErrorResponseBody).code).toBe('VIDEO_NOT_FOUND');
    });

    it('reports awaiting_upload for a fresh draft', async () => {
      const id = (await createDraft()).media.id;

      const response = await request(app.getHttpServer())
        .get(`/admin/media/${id}/status`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.OK);

      const status = response.body as AdminMediaStatusDto;
      expect(status.id).toBe(id);
      expect(status.lifecycleState).toBe('draft');
      expect(status.processing.status).toBe('awaiting_upload');
      expect(status.processing.canRetry).toBe(false);
    });

    it('reports a promoted generation as ready, with its renditions', async () => {
      const id = await createReadyMedia();
      const renditions = [
        { name: '480p', width: 854, height: 480, bandwidth: 1_200_000 },
      ];
      await prisma.video.update({
        where: { id },
        data: {
          processingState: 'ready',
          processingVersion: 1,
          hlsMasterKey: `admin-media/${id}/hls/v1-a1-abc/master.m3u8`,
          hlsRenditions: renditions,
          transcodeProfileVersion: 'v1-a1',
        },
      });

      const response = await request(app.getHttpServer())
        .get(`/admin/media/${id}/status`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.OK);

      const status = response.body as AdminMediaStatusDto;
      expect(status.processing.status).toBe('ready');
      expect(status.processing.hlsReady).toBe(true);
      expect(status.processing.renditions).toEqual(renditions);
    });

    // A status poll is the most frequently hit admin route, so it is the
    // one that most matters must never hand out storage authorization.
    it('never exposes a presigned URL or credential material', async () => {
      const id = await createReadyMedia();

      const response = await request(app.getHttpServer())
        .get(`/admin/media/${id}/status`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.OK);

      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain('X-Amz-Signature');
      expect(serialized).not.toMatch(/https?:\/\//);
      expect(serialized.toLowerCase()).not.toContain('secretaccesskey');
    });

    it('is also embedded on the full admin media record', async () => {
      const id = await createReadyMedia();

      const response = await request(app.getHttpServer())
        .get(`/admin/media/${id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.OK);

      const media = response.body as AdminMediaDto;
      // Flag off in this suite, so a finalized row has no pipeline at all.
      expect(media.processing.status).toBe('uploaded');
      expect(media.processing.state).toBeNull();
      expect(media.processing.canRetry).toBe(false);
    });
  });

  describe('POST /admin/media/:id/complete-upload — zero-byte object', () => {
    // Scoped to a LEGACY row (no recorded expectation) on purpose: a row
    // WITH an expectation still answers `UPLOAD_SIZE_MISMATCH`, which
    // `admin-media.e2e-spec.ts` already pins and this work unit did not
    // change. The legacy row is the case the new check exists for.
    it('refuses an empty object on a legacy row with 409 UPLOAD_OBJECT_EMPTY, leaving it draft', async () => {
      const id = (await createDraft()).media.id;
      await prisma.video.update({
        where: { id },
        data: { expectedSizeBytes: null, expectedContentType: null },
      });
      mockStorageService.headObject.mockResolvedValue({
        key: `admin-media/${id}/source`,
        contentLength: 0,
        contentType: 'video/mp4',
      });

      const response = await request(app.getHttpServer())
        .post(`/admin/media/${id}/complete-upload`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({})
        .expect(HttpStatus.CONFLICT);

      expect((response.body as ErrorResponseBody).code).toBe(
        'UPLOAD_OBJECT_EMPTY',
      );

      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.lifecycleState).toBe('draft');
    });
  });

  describe('POST /admin/media/:id/retry-transcode', () => {
    it('returns 401 without a token', async () => {
      const id = await createReadyMedia();

      await request(app.getHttpServer())
        .post(`/admin/media/${id}/retry-transcode`)
        .send({})
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('returns 403 ADMIN_ROLE_REQUIRED for an authenticated non-admin', async () => {
      const id = await createReadyMedia();

      const response = await request(app.getHttpServer())
        .post(`/admin/media/${id}/retry-transcode`)
        .set('Authorization', `Bearer ${nonAdminAccessToken}`)
        .send({})
        .expect(HttpStatus.FORBIDDEN);

      expect((response.body as ErrorResponseBody).code).toBe(
        'ADMIN_ROLE_REQUIRED',
      );
    });

    it('returns 404 for an unknown media id', async () => {
      await request(app.getHttpServer())
        .post('/admin/media/media-does-not-exist/retry-transcode')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({})
        .expect(HttpStatus.NOT_FOUND);
    });

    // With TRANSCODE_ENABLED off there is no queue to place work on, so the
    // route refuses loudly rather than leaving a row "queued" forever.
    it('refuses with 409 MEDIA_TRANSCODE_NOT_ENABLED when transcoding is disabled', async () => {
      const id = await createReadyMedia();
      await prisma.video.update({
        where: { id },
        data: {
          processingState: 'failed',
          processingErrorCode: 'TRANSCODE_FAILED',
        },
      });

      const response = await request(app.getHttpServer())
        .post(`/admin/media/${id}/retry-transcode`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({})
        .expect(HttpStatus.CONFLICT);

      expect((response.body as ErrorResponseBody).code).toBe(
        'MEDIA_TRANSCODE_NOT_ENABLED',
      );

      // The row is untouched: still failed, still at its original version.
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingState).toBe('failed');
    });

    // The route must never issue an upload authorization — a retry
    // re-processes bytes that are already stored.
    it('never returns a presigned upload URL', async () => {
      const id = await createReadyMedia();
      mockStorageService.createPresignedPutUrl.mockClear();

      const response = await request(app.getHttpServer())
        .post(`/admin/media/${id}/retry-transcode`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({});

      expect(JSON.stringify(response.body)).not.toContain('X-Amz-Signature');
      expect(mockStorageService.createPresignedPutUrl).not.toHaveBeenCalled();
    });
  });
});
