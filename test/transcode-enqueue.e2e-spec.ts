import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { StorageService } from './../src/storage/storage.service';
import { TRANSCODE_QUEUE } from './../src/transcode/transcode.types';
import { buildTranscodeJobId } from './../src/transcode/transcode.constants';
import type { AuthResponseDto } from './../src/auth/auth.types';
import { e2eSuiteBootBudgetMs } from './../src/common/testing/e2e-boot-budget.helpers';

interface CreateUploadResponseBody {
  media: { id: string; lifecycleState: string };
  upload: { url: string; key: string; expiresAt: string };
}

/** `POST /admin/media/:id/complete-upload` returns the AdminMediaDto flat, unwrapped. */
interface AdminMediaResponseBody {
  id: string;
  lifecycleState: string;
}

const UPLOAD_SIZE_BYTES = 1024;

function buildCreateBody(seriesId: string, episodeNumber: number) {
  return {
    seriesId,
    title: 'Transcode Enqueue E2E',
    episodeNumber,
    channelName: 'E2E Channel',
    caption: 'E2E caption',
    category: 'drama',
    sourceLanguage: 'zh',
    hasEmbeddedIndonesianSubtitle: true,
    sizeBytes: UPLOAD_SIZE_BYTES,
    contentType: 'video/mp4',
  };
}

function buildMockStorageService() {
  return {
    createPresignedPutUrl: jest.fn().mockResolvedValue({
      url: 'https://signed.example.test/put',
      key: 'admin-media/mock/source',
      expiresAt: new Date(Date.now() + 60_000),
    }),
    createPresignedGetUrl: jest.fn(),
    headObject: jest.fn().mockResolvedValue({
      key: 'admin-media/mock/source',
      contentLength: UPLOAD_SIZE_BYTES,
      contentType: 'video/mp4',
    }),
    objectExists: jest.fn().mockResolvedValue(true),
    deleteObject: jest.fn(),
    buildPublicUrl: jest.fn(),
  };
}

async function registerAdmin(
  app: INestApplication<App>,
  email: string,
): Promise<string> {
  const registerResponse = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password: 'correct-horse-battery' })
    .expect(HttpStatus.CREATED);
  const accessToken = (registerResponse.body as AuthResponseDto).accessToken;

  await request(app.getHttpServer())
    .post('/dev/admin/grant-role')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({})
    .expect(HttpStatus.CREATED);

  return accessToken;
}

/**
 * Slice 11N — proofs 4, 6, 7 (and additional wiring coverage for the
 * `AdminMediaService.completeUpload` enqueue point). Deliberately a
 * SEPARATE file from `test/admin-media.e2e-spec.ts` (which stays completely
 * unmodified — see that file's own "existing complete-upload behavior"
 * regression requirement, proof 5) so this slice's new assertions can never
 * be mistaken for a change to that pre-existing, must-pass-unchanged suite.
 */
describe('Slice 11N — transcode enqueue on complete-upload (e2e)', () => {
  describe('TRANSCODE_ENABLED=false (default) — zero queue interaction (proof 4)', () => {
    let app: INestApplication<App>;
    let mockStorageService: ReturnType<typeof buildMockStorageService>;
    let mockQueueAdd: jest.Mock;

    const emailPrefix = 'transcode-enqueue-e2e-off';
    const seriesId = `${emailPrefix}-series`;

    beforeAll(async () => {
      process.env.DEV_TOOLS_ENABLED = 'true';
      mockStorageService = buildMockStorageService();
      mockQueueAdd = jest.fn().mockResolvedValue(undefined);

      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(StorageService)
        .useValue(mockStorageService)
        // Overridden even though the flag is off, specifically so "zero
        // calls" below is a genuine assertion against a real mock, not
        // merely "the noop client was used" (which this override bypasses
        // entirely — proving AdminMediaService itself never reaches the
        // queue at all while the flag is off, regardless of which
        // implementation TranscodeModule would otherwise have wired up).
        .overrideProvider(TRANSCODE_QUEUE)
        .useValue({ add: mockQueueAdd })
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
    }, e2eSuiteBootBudgetMs());

    afterAll(async () => {
      const prisma = app.get<PrismaService>(PrismaService);
      await prisma.video.deleteMany({ where: { seriesId } });
      await prisma.user.deleteMany({
        where: { email: { contains: emailPrefix } },
      });
      await app.close();
      delete process.env.DEV_TOOLS_ENABLED;
    });

    it('completes the upload successfully and never calls the queue', async () => {
      const accessToken = await registerAdmin(
        app,
        `${emailPrefix}-${Date.now()}@example.test`,
      );

      const createResponse = await request(app.getHttpServer())
        .post('/admin/media')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(buildCreateBody(seriesId, 1))
        .expect(HttpStatus.CREATED);
      const mediaId = (createResponse.body as CreateUploadResponseBody).media
        .id;

      const completeResponse = await request(app.getHttpServer())
        .post(`/admin/media/${mediaId}/complete-upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(HttpStatus.OK);

      expect(
        (completeResponse.body as AdminMediaResponseBody).lifecycleState,
      ).toBe('ready');
      expect(mockQueueAdd).not.toHaveBeenCalled();

      const prisma = app.get<PrismaService>(PrismaService);
      const row = await prisma.video.findUnique({ where: { id: mediaId } });
      expect(row?.processingState).toBeNull();
      expect(row?.processingVersion).toBe(0);
    });
  });

  describe('TRANSCODE_ENABLED=false, REDIS_URL absent — module init and complete-upload both succeed (proof 6)', () => {
    let app: INestApplication<App>;
    let mockStorageService: ReturnType<typeof buildMockStorageService>;
    const previousRedisUrl = process.env.REDIS_URL;

    const emailPrefix = 'transcode-enqueue-e2e-no-redis';
    const seriesId = `${emailPrefix}-series`;

    beforeAll(async () => {
      process.env.DEV_TOOLS_ENABLED = 'true';
      delete process.env.TRANSCODE_ENABLED;
      delete process.env.REDIS_URL;
      mockStorageService = buildMockStorageService();

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
    }, e2eSuiteBootBudgetMs());

    afterAll(async () => {
      const prisma = app.get<PrismaService>(PrismaService);
      await prisma.video.deleteMany({ where: { seriesId } });
      await prisma.user.deleteMany({
        where: { email: { contains: emailPrefix } },
      });
      await app.close();
      delete process.env.DEV_TOOLS_ENABLED;
      if (previousRedisUrl === undefined) {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = previousRedisUrl;
      }
    });

    it('boots and completes an upload with no REDIS_URL configured at all', async () => {
      const accessToken = await registerAdmin(
        app,
        `${emailPrefix}-${Date.now()}@example.test`,
      );

      const createResponse = await request(app.getHttpServer())
        .post('/admin/media')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(buildCreateBody(seriesId, 1))
        .expect(HttpStatus.CREATED);
      const mediaId = (createResponse.body as CreateUploadResponseBody).media
        .id;

      await request(app.getHttpServer())
        .post(`/admin/media/${mediaId}/complete-upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(HttpStatus.OK);
    });
  });

  /**
   * TRANSCODE_ENABLED=true here is exactly the "explicitly-scoped test case
   * that mocks the queue" the control workspace's hard-prohibition list
   * carves out — `TRANSCODE_QUEUE` is overridden with a jest mock BEFORE the
   * module compiles, so the real `BullmqTranscodeQueueClient` factory branch
   * is never reached and no real Redis connection is ever attempted, even
   * though a (deliberately fake, unreachable) `REDIS_URL` is set only to
   * satisfy `env.validation.ts`'s presence check at boot.
   */
  describe('TRANSCODE_ENABLED=true, queue mocked — requestProcessing wiring (proof 7)', () => {
    let app: INestApplication<App>;
    let mockStorageService: ReturnType<typeof buildMockStorageService>;
    let mockQueueAdd: jest.Mock;
    const previousTranscodeEnabled = process.env.TRANSCODE_ENABLED;
    const previousRedisUrl = process.env.REDIS_URL;

    const emailPrefix = 'transcode-enqueue-e2e-on';
    const seriesId = `${emailPrefix}-series`;

    beforeAll(async () => {
      process.env.DEV_TOOLS_ENABLED = 'true';
      process.env.TRANSCODE_ENABLED = 'true';
      process.env.REDIS_URL = 'redis://127.0.0.1:65535/0';
      mockStorageService = buildMockStorageService();
      mockQueueAdd = jest.fn().mockResolvedValue(undefined);

      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(StorageService)
        .useValue(mockStorageService)
        .overrideProvider(TRANSCODE_QUEUE)
        .useValue({ add: mockQueueAdd })
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
    }, e2eSuiteBootBudgetMs());

    afterAll(async () => {
      const prisma = app.get<PrismaService>(PrismaService);
      await prisma.video.deleteMany({ where: { seriesId } });
      await prisma.user.deleteMany({
        where: { email: { contains: emailPrefix } },
      });
      await app.close();
      delete process.env.DEV_TOOLS_ENABLED;
      if (previousTranscodeEnabled === undefined) {
        delete process.env.TRANSCODE_ENABLED;
      } else {
        process.env.TRANSCODE_ENABLED = previousTranscodeEnabled;
      }
      if (previousRedisUrl === undefined) {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = previousRedisUrl;
      }
    });

    it('requests HLS processing exactly once, with a payload containing ONLY videoId + processingVersion', async () => {
      const accessToken = await registerAdmin(
        app,
        `${emailPrefix}-${Date.now()}@example.test`,
      );

      const createResponse = await request(app.getHttpServer())
        .post('/admin/media')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(buildCreateBody(seriesId, 1))
        .expect(HttpStatus.CREATED);
      const mediaId = (createResponse.body as CreateUploadResponseBody).media
        .id;

      await request(app.getHttpServer())
        .post(`/admin/media/${mediaId}/complete-upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(HttpStatus.OK);

      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      const [jobId, payload] = mockQueueAdd.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(jobId).toBe(buildTranscodeJobId(mediaId, 1));
      expect(Object.keys(payload).sort()).toEqual([
        'processingVersion',
        'videoId',
      ]);
      expect(payload).toEqual({ videoId: mediaId, processingVersion: 1 });

      const prisma = app.get<PrismaService>(PrismaService);
      const row = await prisma.video.findUnique({ where: { id: mediaId } });
      expect(row?.processingState).toBe('queued');
      expect(row?.processingVersion).toBe(1);
      // The editorial axis is untouched by the processing request.
      expect(row?.lifecycleState).toBe('ready');
    });
  });
});
