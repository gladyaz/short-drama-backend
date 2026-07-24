import { Test, TestingModule } from '@nestjs/testing';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { AdminMediaService } from './admin-media.service';
import { MediaLifecycleService } from './media-lifecycle.service';

/**
 * Phase 11, work unit 11B-3: `StorageService` is entirely mocked here — no
 * test in this file constructs a real `S3Client` or makes any network
 * call. `PrismaService` is the real client against the project's Postgres
 * test database (following the existing `EntitlementsService`/
 * `AdminService` integration-style precedent), self-cleaning via
 * `afterEach`.
 */
describe('AdminMediaService', () => {
  let service: AdminMediaService;
  let prisma: PrismaService;
  let storageService: {
    createPresignedPutUrl: jest.Mock;
    objectExists: jest.Mock;
  };

  const testIdPrefix = 'admin-media-spec-11b3';

  beforeEach(async () => {
    storageService = {
      createPresignedPutUrl: jest.fn(),
      objectExists: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminMediaService,
        MediaLifecycleService,
        PrismaService,
        { provide: StorageService, useValue: storageService },
      ],
    }).compile();

    service = module.get<AdminMediaService>(AdminMediaService);
    prisma = module.get<PrismaService>(PrismaService);
    await prisma.onModuleInit();
  });

  afterEach(async () => {
    await prisma.video.deleteMany({
      where: { seriesId: { startsWith: testIdPrefix } },
    });
    await prisma.onModuleDestroy();
  });

  const baseDto = {
    seriesId: `${testIdPrefix}-series`,
    title: 'Spec Media',
    episodeNumber: 1,
    channelName: 'Spec Channel',
    caption: 'Spec caption',
    category: 'drama',
    sourceLanguage: 'zh',
    hasEmbeddedIndonesianSubtitle: true,
  };

  describe('createUpload', () => {
    it('creates a draft media record and returns a presigned PUT URL from the mocked StorageService', async () => {
      storageService.createPresignedPutUrl.mockResolvedValue({
        url: 'https://signed.example.test/put',
        key: 'admin-media/media-abc/source',
        expiresAt: new Date('2026-01-01T00:00:10.000Z'),
      });

      const result = await service.createUpload({
        ...baseDto,
        contentType: 'video/mp4',
      });

      expect(result.media.lifecycleState).toBe('draft');
      expect(result.media.objectStorageKey).toBe(
        `admin-media/${result.media.id}/source`,
      );
      expect(result.media.objectStorageVariant).toBe('source');
      expect(result.upload.url).toBe('https://signed.example.test/put');
      expect(storageService.createPresignedPutUrl).toHaveBeenCalledWith(
        `admin-media/${result.media.id}/source`,
        { contentType: 'video/mp4' },
      );

      const persisted = await prisma.video.findUnique({
        where: { id: result.media.id },
      });
      expect(persisted?.storageKey).toBe('');
      expect(persisted?.lifecycleState).toBe('draft');
    });

    it('generates a distinct id for each call', async () => {
      storageService.createPresignedPutUrl.mockResolvedValue({
        url: 'https://signed.example.test/put',
        key: 'k',
        expiresAt: new Date(),
      });

      const first = await service.createUpload(baseDto);
      const second = await service.createUpload(baseDto);

      expect(first.media.id).not.toBe(second.media.id);
    });
  });

  describe('completeUpload', () => {
    async function createDraft(): Promise<string> {
      storageService.createPresignedPutUrl.mockResolvedValue({
        url: 'https://signed.example.test/put',
        key: 'k',
        expiresAt: new Date(),
      });
      const created = await service.createUpload(baseDto);
      return created.media.id;
    }

    it('transitions draft -> ready when the object exists in storage', async () => {
      const id = await createDraft();
      storageService.objectExists.mockResolvedValue(true);

      const result = await service.completeUpload(id, {
        durationSeconds: 120,
        width: 1080,
        height: 1920,
      });

      expect(result.lifecycleState).toBe('ready');
      expect(result.durationSeconds).toBe(120);
      expect(result.width).toBe(1080);
      expect(result.height).toBe(1920);
      expect(storageService.objectExists).toHaveBeenCalledWith(
        `admin-media/${id}/source`,
      );
    });

    it('rejects with a 400 when the object does not exist in storage', async () => {
      const id = await createDraft();
      storageService.objectExists.mockResolvedValue(false);

      let caught: unknown;
      try {
        await service.completeUpload(id, {});
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AppException);
      expect((caught as AppException).code).toBe(
        AppErrorCode.MEDIA_FILE_NOT_FOUND,
      );

      const persisted = await prisma.video.findUnique({ where: { id } });
      expect(persisted?.lifecycleState).toBe('draft'); // unchanged
    });

    it('rejects VIDEO_NOT_FOUND for an unknown id', async () => {
      await expect(
        service.completeUpload('does-not-exist', {}),
      ).rejects.toMatchObject({ code: AppErrorCode.VIDEO_NOT_FOUND });
    });

    it('rejects with INVALID_MEDIA_LIFECYCLE_TRANSITION when the record is already ready (not a draft)', async () => {
      const id = await createDraft();
      storageService.objectExists.mockResolvedValue(true);
      await service.completeUpload(id, {});

      await expect(service.completeUpload(id, {})).rejects.toMatchObject({
        code: AppErrorCode.INVALID_MEDIA_LIFECYCLE_TRANSITION,
      });
    });
  });

  describe('publish / unpublish', () => {
    async function createReadyMedia(): Promise<string> {
      storageService.createPresignedPutUrl.mockResolvedValue({
        url: 'https://signed.example.test/put',
        key: 'k',
        expiresAt: new Date(),
      });
      const created = await service.createUpload(baseDto);
      storageService.objectExists.mockResolvedValue(true);
      await service.completeUpload(created.media.id, {});
      return created.media.id;
    }

    it('publishes a ready record', async () => {
      const id = await createReadyMedia();
      const result = await service.publish(id);
      expect(result.lifecycleState).toBe('published');
    });

    it('rejects publishing a draft directly (must go through ready first)', async () => {
      storageService.createPresignedPutUrl.mockResolvedValue({
        url: 'https://signed.example.test/put',
        key: 'k',
        expiresAt: new Date(),
      });
      const created = await service.createUpload(baseDto);

      await expect(service.publish(created.media.id)).rejects.toMatchObject({
        code: AppErrorCode.INVALID_MEDIA_LIFECYCLE_TRANSITION,
      });
    });

    it('unpublishes a published record, and it can be re-published', async () => {
      const id = await createReadyMedia();
      await service.publish(id);

      const unpublished = await service.unpublish(id);
      expect(unpublished.lifecycleState).toBe('unpublished');

      const republished = await service.publish(id);
      expect(republished.lifecycleState).toBe('published');
    });

    it('rejects VIDEO_NOT_FOUND for an unknown id', async () => {
      await expect(service.publish('does-not-exist')).rejects.toMatchObject({
        code: AppErrorCode.VIDEO_NOT_FOUND,
      });
    });
  });

  describe('createCoverUpload / createThumbnailUpload', () => {
    it('persists coverImageKey and returns a presigned URL', async () => {
      storageService.createPresignedPutUrl
        .mockResolvedValueOnce({
          url: 'https://signed.example.test/put-source',
          key: 'k',
          expiresAt: new Date(),
        })
        .mockResolvedValueOnce({
          url: 'https://signed.example.test/put-cover',
          key: 'admin-media/x/cover',
          expiresAt: new Date(),
        });

      const created = await service.createUpload(baseDto);
      const result = await service.createCoverUpload(created.media.id, {
        contentType: 'image/jpeg',
      });

      expect(result.upload.url).toBe('https://signed.example.test/put-cover');
      expect(result.media.coverImageKey).toBe(
        `admin-media/${created.media.id}/cover`,
      );
    });

    it('persists thumbnailImageKey and returns a presigned URL', async () => {
      storageService.createPresignedPutUrl
        .mockResolvedValueOnce({
          url: 'https://signed.example.test/put-source',
          key: 'k',
          expiresAt: new Date(),
        })
        .mockResolvedValueOnce({
          url: 'https://signed.example.test/put-thumb',
          key: 'admin-media/x/thumbnail',
          expiresAt: new Date(),
        });

      const created = await service.createUpload(baseDto);
      const result = await service.createThumbnailUpload(created.media.id, {});

      expect(result.upload.url).toBe('https://signed.example.test/put-thumb');
      expect(result.media.thumbnailImageKey).toBe(
        `admin-media/${created.media.id}/thumbnail`,
      );
    });

    it('rejects VIDEO_NOT_FOUND for an unknown id', async () => {
      await expect(
        service.createCoverUpload('does-not-exist', {}),
      ).rejects.toMatchObject({ code: AppErrorCode.VIDEO_NOT_FOUND });
    });
  });

  describe('findById', () => {
    it('returns the admin view of a media record', async () => {
      storageService.createPresignedPutUrl.mockResolvedValue({
        url: 'https://signed.example.test/put',
        key: 'k',
        expiresAt: new Date(),
      });
      const created = await service.createUpload(baseDto);

      const found = await service.findById(created.media.id);
      expect(found.id).toBe(created.media.id);
      expect(found.lifecycleState).toBe('draft');
    });

    it('rejects VIDEO_NOT_FOUND for an unknown id', async () => {
      await expect(service.findById('does-not-exist')).rejects.toMatchObject({
        code: AppErrorCode.VIDEO_NOT_FOUND,
      });
    });
  });
});
