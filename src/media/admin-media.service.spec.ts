import { Test, TestingModule } from '@nestjs/testing';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { AdminMediaService } from './admin-media.service';
import { MediaLifecycleService } from './media-lifecycle.service';
import { MediaLifecycleState } from './media-lifecycle.types';

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

  describe('list', () => {
    /**
     * Creates a media record and drives it through the lifecycle states
     * needed to reach `targetState` via the service's own public methods
     * (never a raw Prisma write), so the fixtures are realistic. `failed`
     * has no reachable transition from this pipeline, so it is written
     * directly via `prisma.video.update` for that one state only.
     */
    async function createMediaAt(
      state: 'draft' | 'ready' | 'published' | 'unpublished' | 'failed',
      overrides: { seriesId?: string; sortOrder?: number } = {},
    ): Promise<string> {
      storageService.createPresignedPutUrl.mockResolvedValue({
        url: 'https://signed.example.test/put',
        key: 'k',
        expiresAt: new Date(),
      });
      const created = await service.createUpload({
        ...baseDto,
        seriesId: overrides.seriesId ?? baseDto.seriesId,
      });
      const id = created.media.id;

      if (state === 'draft') {
        return id;
      }

      storageService.objectExists.mockResolvedValue(true);
      await service.completeUpload(id, {});
      if (state === 'ready') {
        return id;
      }

      if (state === 'failed') {
        await prisma.video.update({
          where: { id },
          data: { lifecycleState: 'failed' },
        });
        return id;
      }

      await service.publish(id);
      if (state === 'published') {
        return id;
      }

      await service.unpublish(id);
      return id;
    }

    it('lists media rows across multiple lifecycle states', async () => {
      const draftId = await createMediaAt('draft');
      const readyId = await createMediaAt('ready');
      const publishedId = await createMediaAt('published');
      const unpublishedId = await createMediaAt('unpublished');
      const failedId = await createMediaAt('failed');

      const result = await service.list({
        seriesId: baseDto.seriesId,
        page: 1,
        pageSize: 20,
      });

      const ids = result.items.map((item) => item.id);
      expect(ids).toEqual(
        expect.arrayContaining([
          draftId,
          readyId,
          publishedId,
          unpublishedId,
          failedId,
        ]),
      );
      expect(result.total).toBe(5);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
    });

    it('filters by status', async () => {
      await createMediaAt('draft');
      const publishedId = await createMediaAt('published');

      const result = await service.list({
        status: MediaLifecycleState.PUBLISHED,
        seriesId: baseDto.seriesId,
        page: 1,
        pageSize: 20,
      });

      expect(result.items.map((item) => item.id)).toEqual([publishedId]);
      expect(result.total).toBe(1);
    });

    it('filters by seriesId', async () => {
      const otherSeriesId = `${baseDto.seriesId}-other`;
      const matchingId = await createMediaAt('draft', {
        seriesId: baseDto.seriesId,
      });
      await createMediaAt('draft', { seriesId: otherSeriesId });

      const result = await service.list({
        seriesId: baseDto.seriesId,
        page: 1,
        pageSize: 20,
      });

      expect(result.items.map((item) => item.id)).toEqual([matchingId]);

      // `otherSeriesId` still starts with `testIdPrefix`, so the module's
      // `afterEach` sweep (`seriesId: { startsWith: testIdPrefix }`) covers
      // it too — no extra cleanup needed here.
    });

    it('paginates deterministically ordered by sortOrder then id', async () => {
      const firstId = await createMediaAt('draft');
      const secondId = await createMediaAt('draft');
      const thirdId = await createMediaAt('draft');

      const pageOne = await service.list({
        seriesId: baseDto.seriesId,
        page: 1,
        pageSize: 2,
      });
      const pageTwo = await service.list({
        seriesId: baseDto.seriesId,
        page: 2,
        pageSize: 2,
      });

      expect(pageOne.items).toHaveLength(2);
      expect(pageTwo.items).toHaveLength(1);
      expect(pageOne.total).toBe(3);
      expect(pageTwo.total).toBe(3);

      const orderedIds = [...pageOne.items, ...pageTwo.items].map(
        (item) => item.id,
      );
      expect(orderedIds).toEqual(
        [firstId, secondId, thirdId].sort((a, b) => (a < b ? -1 : 1)),
      );
    });

    it('defaults to page 1 / pageSize 20 when omitted', async () => {
      await createMediaAt('draft');

      const result = await service.list({
        seriesId: baseDto.seriesId,
        page: 1,
        pageSize: 20,
      });

      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
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

  describe('updateMetadata', () => {
    async function createMedia(): Promise<string> {
      storageService.createPresignedPutUrl.mockResolvedValue({
        url: 'https://signed.example.test/put',
        key: 'k',
        expiresAt: new Date(),
      });
      const created = await service.createUpload(baseDto);
      return created.media.id;
    }

    it('updates a single field and leaves the rest unchanged', async () => {
      const id = await createMedia();

      const result = await service.updateMetadata(id, {
        title: 'Updated Title',
      });

      expect(result.title).toBe('Updated Title');
      expect(result.caption).toBe(baseDto.caption);
      expect(result.category).toBe(baseDto.category);
      expect(result.channelName).toBe(baseDto.channelName);
      expect(result.sourceLanguage).toBe(baseDto.sourceLanguage);
      expect(result.episodeNumber).toBe(baseDto.episodeNumber);
      expect(result.hasEmbeddedIndonesianSubtitle).toBe(
        baseDto.hasEmbeddedIndonesianSubtitle,
      );
    });

    it('updates multiple fields at once and returns the updated DTO', async () => {
      const id = await createMedia();

      const result = await service.updateMetadata(id, {
        title: 'New Title',
        caption: 'New caption',
        category: 'comedy',
        channelName: 'New Channel',
        sourceLanguage: 'en',
        episodeNumber: 7,
        hasEmbeddedIndonesianSubtitle: false,
      });

      expect(result).toMatchObject({
        id,
        title: 'New Title',
        caption: 'New caption',
        category: 'comedy',
        channelName: 'New Channel',
        sourceLanguage: 'en',
        episodeNumber: 7,
        hasEmbeddedIndonesianSubtitle: false,
      });
    });

    it('leaves lifecycle/object-storage/derived fields untouched', async () => {
      const id = await createMedia();
      storageService.objectExists.mockResolvedValue(true);
      await service.completeUpload(id, {
        durationSeconds: 42,
        width: 100,
        height: 200,
      });
      await service.publish(id);

      const before = await service.findById(id);

      const result = await service.updateMetadata(id, { title: 'Retitled' });

      expect(result.title).toBe('Retitled');
      expect(result.lifecycleState).toBe(before.lifecycleState);
      expect(result.objectStorageKey).toBe(before.objectStorageKey);
      expect(result.objectStorageVariant).toBe(before.objectStorageVariant);
      expect(result.coverImageKey).toBe(before.coverImageKey);
      expect(result.thumbnailImageKey).toBe(before.thumbnailImageKey);
      expect(result.durationSeconds).toBe(before.durationSeconds);
      expect(result.width).toBe(before.width);
      expect(result.height).toBe(before.height);

      const persisted = await prisma.video.findUnique({ where: { id } });
      expect(persisted?.likeCount).toBe(0);
      expect(persisted?.sortOrder).toBe(0);
    });

    it('rejects an empty body with EMPTY_MEDIA_METADATA_UPDATE', async () => {
      const id = await createMedia();

      await expect(service.updateMetadata(id, {})).rejects.toMatchObject({
        code: AppErrorCode.EMPTY_MEDIA_METADATA_UPDATE,
      });
    });

    it('rejects VIDEO_NOT_FOUND for an unknown id', async () => {
      await expect(
        service.updateMetadata('does-not-exist', { title: 'X' }),
      ).rejects.toMatchObject({ code: AppErrorCode.VIDEO_NOT_FOUND });
    });
  });
});
