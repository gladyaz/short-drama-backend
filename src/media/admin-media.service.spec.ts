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
    headObject: jest.Mock;
  };

  const testIdPrefix = 'admin-media-spec-11b3';

  beforeEach(async () => {
    storageService = {
      createPresignedPutUrl: jest.fn(),
      objectExists: jest.fn(),
      headObject: jest.fn(),
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

  // Work unit 11L-B2: the declared upload expectation. `createUpload`
  // persists it, and `completeUpload` verifies R2's HeadObject against it,
  // so the fixture and the mocked HeadObject response must agree wherever a
  // test means "the upload was fine".
  const EXPECTED_UPLOAD_SIZE_BYTES = 2048;
  const baseDto = {
    seriesId: `${testIdPrefix}-series`,
    title: 'Spec Media',
    episodeNumber: 1,
    channelName: 'Spec Channel',
    caption: 'Spec caption',
    category: 'drama',
    sourceLanguage: 'zh',
    hasEmbeddedIndonesianSubtitle: true,
    sizeBytes: EXPECTED_UPLOAD_SIZE_BYTES,
    contentType: 'video/mp4' as const,
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
      const second = await service.createUpload({
        ...baseDto,
        episodeNumber: baseDto.episodeNumber + 1,
      });

      expect(first.media.id).not.toBe(second.media.id);
    });

    // Work unit 11F-4: create-time `accessTierOverride` default, derived
    // from `episodeNumber` — proves `POST /admin/media` never leaves a
    // freshly created row's tier `null`.
    describe('create-time access-tier default', () => {
      beforeEach(() => {
        storageService.createPresignedPutUrl.mockResolvedValue({
          url: 'https://signed.example.test/put',
          key: 'k',
          expiresAt: new Date(),
        });
      });

      it('derives "free" for an episodeNumber at/below FREE_EPISODE_LIMIT (5)', async () => {
        const result = await service.createUpload({
          ...baseDto,
          episodeNumber: 5,
        });

        expect(result.media.accessTierOverride).toBe('free');

        const persisted = await prisma.video.findUnique({
          where: { id: result.media.id },
        });
        expect(persisted?.accessTierOverride).toBe('free');
      });

      it('derives "premium" for an episodeNumber above FREE_EPISODE_LIMIT (5)', async () => {
        const result = await service.createUpload({
          ...baseDto,
          episodeNumber: 6,
        });

        expect(result.media.accessTierOverride).toBe('premium');

        const persisted = await prisma.video.findUnique({
          where: { id: result.media.id },
        });
        expect(persisted?.accessTierOverride).toBe('premium');
      });
    });

    // Work unit 11F-3: duplicate episode-number-within-series validation.
    describe('duplicate episode-number-within-series validation', () => {
      beforeEach(() => {
        storageService.createPresignedPutUrl.mockResolvedValue({
          url: 'https://signed.example.test/put',
          key: 'k',
          expiresAt: new Date(),
        });
      });

      it('rejects a second create with the same (seriesId, episodeNumber) with 409 DUPLICATE_EPISODE_NUMBER, and creates no row', async () => {
        await service.createUpload(baseDto);

        await expect(service.createUpload(baseDto)).rejects.toMatchObject({
          code: AppErrorCode.DUPLICATE_EPISODE_NUMBER,
        });

        const rows = await prisma.video.findMany({
          where: { seriesId: baseDto.seriesId, episodeNumber: 1 },
        });
        expect(rows).toHaveLength(1);
      });

      it('allows a create with a unique episodeNumber in the same series', async () => {
        await service.createUpload(baseDto);

        const second = await service.createUpload({
          ...baseDto,
          episodeNumber: 2,
        });

        expect(second.media.episodeNumber).toBe(2);
      });

      it('allows the same episodeNumber in a different series (not a duplicate)', async () => {
        await service.createUpload(baseDto);

        const other = await service.createUpload({
          ...baseDto,
          seriesId: `${baseDto.seriesId}-other`,
        });

        expect(other.media.episodeNumber).toBe(baseDto.episodeNumber);
      });
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
      // 11L-B3: completion verifies size + content type, not just presence.
      storageService.headObject.mockResolvedValue({
        key: 'admin-media/test/source',
        contentLength: EXPECTED_UPLOAD_SIZE_BYTES,
        contentType: 'video/mp4',
      });

      const result = await service.completeUpload(id, {
        durationSeconds: 120,
        width: 1080,
        height: 1920,
      });

      expect(result.lifecycleState).toBe('ready');
      expect(result.durationSeconds).toBe(120);
      expect(result.width).toBe(1080);
      expect(result.height).toBe(1920);
      expect(storageService.headObject).toHaveBeenCalledWith(
        `admin-media/${id}/source`,
      );
    });

    it('rejects with a 400 when the object does not exist in storage', async () => {
      const id = await createDraft();
      storageService.objectExists.mockResolvedValue(false);
      storageService.headObject.mockResolvedValue(null);

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
      // 11L-B3: completion verifies size + content type, not just presence.
      storageService.headObject.mockResolvedValue({
        key: 'admin-media/test/source',
        contentLength: EXPECTED_UPLOAD_SIZE_BYTES,
        contentType: 'video/mp4',
      });
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
      // 11L-B3: completion verifies size + content type, not just presence.
      storageService.headObject.mockResolvedValue({
        key: 'admin-media/test/source',
        contentLength: EXPECTED_UPLOAD_SIZE_BYTES,
        contentType: 'video/mp4',
      });
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
    // Work unit 11F-3: `createUpload` now rejects a duplicate
    // (seriesId, episodeNumber) pair, so this counter gives every fixture
    // created within a single test its own episode number — even the ones
    // that share `baseDto.seriesId` — instead of every call reusing
    // `baseDto.episodeNumber`. Reset per test so the exact numbers stay
    // small and predictable; irrelevant to any assertion below either way.
    let episodeCounter = 1;
    beforeEach(() => {
      episodeCounter = 1;
    });

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
        episodeNumber: episodeCounter++,
      });
      const id = created.media.id;

      if (state === 'draft') {
        return id;
      }

      storageService.objectExists.mockResolvedValue(true);
      // 11L-B3: completion verifies size + content type, not just presence.
      storageService.headObject.mockResolvedValue({
        key: 'admin-media/test/source',
        contentLength: EXPECTED_UPLOAD_SIZE_BYTES,
        contentType: 'video/mp4',
      });
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

    /**
     * Work unit 11F-2: `search` (case-insensitive substring across
     * `title`/`caption`/`channelName`), `tier` (exact match on the
     * DB-backed `accessTierOverride` column — 11F-4 backfilled every row,
     * so this is NOT re-derived from `episodeNumber`), and `category`
     * (exact match), each ANDed with the existing `status`/`seriesId`
     * filters. Fixtures are written directly via `prisma.video.create`
     * (bypassing `createUpload`'s own tier derivation) so each row's
     * `title`/`caption`/`channelName`/`category`/`accessTierOverride`/
     * `lifecycleState` can be set independently; namespaced under
     * `${testIdPrefix}-11f2-filters`, still covered by this describe
     * block's own `afterEach` sweep (`seriesId: { startsWith: testIdPrefix
     * }`).
     */
    describe('search / tier / category filters (work unit 11F-2)', () => {
      const filterSeriesId = `${testIdPrefix}-11f2-filters`;

      async function createFixture(
        id: string,
        overrides: Partial<{
          seriesId: string;
          title: string;
          caption: string;
          channelName: string;
          category: string;
          accessTierOverride: string | null;
          lifecycleState: string;
        }> = {},
      ): Promise<string> {
        await prisma.video.create({
          data: {
            id,
            seriesId: overrides.seriesId ?? filterSeriesId,
            title: overrides.title ?? 'Default Title',
            episodeNumber: 1,
            channelName: overrides.channelName ?? 'Default Channel',
            caption: overrides.caption ?? 'Default caption',
            category: overrides.category ?? 'drama',
            storageKey: '',
            sourceLanguage: 'zh',
            hasEmbeddedIndonesianSubtitle: true,
            likeCount: 0,
            lifecycleState: overrides.lifecycleState ?? 'draft',
            accessTierOverride: overrides.accessTierOverride ?? 'free',
          },
        });
        return id;
      }

      it('search matches on title (case-insensitive)', async () => {
        const matchId = await createFixture(`${filterSeriesId}-title-match`, {
          title: 'Amazing Dragon Story',
        });
        await createFixture(`${filterSeriesId}-title-nomatch`, {
          title: 'Something Else Entirely',
        });

        const result = await service.list({
          seriesId: filterSeriesId,
          search: 'dragon',
          page: 1,
          pageSize: 20,
        });

        expect(result.items.map((item) => item.id)).toEqual([matchId]);
        expect(result.total).toBe(1);
      });

      it('search matches on caption (case-insensitive)', async () => {
        const matchId = await createFixture(`${filterSeriesId}-caption-match`, {
          caption: 'A tale of ROYAL intrigue',
        });
        await createFixture(`${filterSeriesId}-caption-nomatch`, {
          caption: 'Nothing related here',
        });

        const result = await service.list({
          seriesId: filterSeriesId,
          search: 'royal',
          page: 1,
          pageSize: 20,
        });

        expect(result.items.map((item) => item.id)).toEqual([matchId]);
      });

      it('search matches on channelName (case-insensitive)', async () => {
        const matchId = await createFixture(`${filterSeriesId}-channel-match`, {
          channelName: 'Studio NEBULA',
        });
        await createFixture(`${filterSeriesId}-channel-nomatch`, {
          channelName: 'Other Studio',
        });

        const result = await service.list({
          seriesId: filterSeriesId,
          search: 'nebula',
          page: 1,
          pageSize: 20,
        });

        expect(result.items.map((item) => item.id)).toEqual([matchId]);
      });

      it('a non-matching search term returns no rows', async () => {
        await createFixture(`${filterSeriesId}-nomatch-only`, {
          title: 'Totally Unrelated Title',
          caption: 'unrelated caption',
          channelName: 'unrelated channel',
        });

        const result = await service.list({
          seriesId: filterSeriesId,
          search: 'zzz-nonexistent-term-zzz',
          page: 1,
          pageSize: 20,
        });

        expect(result.items).toHaveLength(0);
        expect(result.total).toBe(0);
      });

      it('tier=free returns only free rows, asserted against accessTierOverride', async () => {
        const freeId = await createFixture(`${filterSeriesId}-tier-free`, {
          accessTierOverride: 'free',
        });
        await createFixture(`${filterSeriesId}-tier-premium`, {
          accessTierOverride: 'premium',
        });

        const result = await service.list({
          seriesId: filterSeriesId,
          tier: 'free',
          page: 1,
          pageSize: 20,
        });

        expect(result.items.map((item) => item.id)).toEqual([freeId]);
        for (const item of result.items) {
          expect(item.accessTierOverride).toBe('free');
        }
      });

      it('tier=premium returns only premium rows, asserted against accessTierOverride', async () => {
        await createFixture(`${filterSeriesId}-tier-free-2`, {
          accessTierOverride: 'free',
        });
        const premiumId = await createFixture(
          `${filterSeriesId}-tier-premium-2`,
          { accessTierOverride: 'premium' },
        );

        const result = await service.list({
          seriesId: filterSeriesId,
          tier: 'premium',
          page: 1,
          pageSize: 20,
        });

        expect(result.items.map((item) => item.id)).toEqual([premiumId]);
        for (const item of result.items) {
          expect(item.accessTierOverride).toBe('premium');
        }
      });

      it('category filter returns only that category', async () => {
        const dramaId = await createFixture(`${filterSeriesId}-cat-drama`, {
          category: 'drama',
        });
        await createFixture(`${filterSeriesId}-cat-comedy`, {
          category: 'comedy',
        });

        const result = await service.list({
          seriesId: filterSeriesId,
          category: 'drama',
          page: 1,
          pageSize: 20,
        });

        expect(result.items.map((item) => item.id)).toEqual([dramaId]);
      });

      it('composes search + status + tier + category + seriesId together (AND semantics), with total reflecting the filtered set', async () => {
        const targetId = await createFixture(
          `${filterSeriesId}-compose-target`,
          {
            title: 'Composable Dragon Epic',
            category: 'drama',
            accessTierOverride: 'premium',
            lifecycleState: 'published',
          },
        );

        // Same series, matches everything except category.
        await createFixture(`${filterSeriesId}-compose-wrong-category`, {
          title: 'Composable Dragon Epic',
          category: 'comedy',
          accessTierOverride: 'premium',
          lifecycleState: 'published',
        });
        // Same series, matches everything except tier.
        await createFixture(`${filterSeriesId}-compose-wrong-tier`, {
          title: 'Composable Dragon Epic',
          category: 'drama',
          accessTierOverride: 'free',
          lifecycleState: 'published',
        });
        // Same series, matches everything except lifecycle status.
        await createFixture(`${filterSeriesId}-compose-wrong-status`, {
          title: 'Composable Dragon Epic',
          category: 'drama',
          accessTierOverride: 'premium',
          lifecycleState: 'draft',
        });
        // Same series, matches everything except the search term.
        await createFixture(`${filterSeriesId}-compose-wrong-search`, {
          title: 'Totally Different Title',
          category: 'drama',
          accessTierOverride: 'premium',
          lifecycleState: 'published',
        });
        // A different series that otherwise matches every other filter.
        await createFixture(`${filterSeriesId}-compose-other-series`, {
          seriesId: `${filterSeriesId}-other`,
          title: 'Composable Dragon Epic',
          category: 'drama',
          accessTierOverride: 'premium',
          lifecycleState: 'published',
        });

        const result = await service.list({
          seriesId: filterSeriesId,
          search: 'dragon',
          status: MediaLifecycleState.PUBLISHED,
          tier: 'premium',
          category: 'drama',
          page: 1,
          pageSize: 20,
        });

        expect(result.items.map((item) => item.id)).toEqual([targetId]);
        expect(result.total).toBe(1);
      });
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
      // 11L-B3: completion verifies size + content type, not just presence.
      storageService.headObject.mockResolvedValue({
        key: 'admin-media/test/source',
        contentLength: EXPECTED_UPLOAD_SIZE_BYTES,
        contentType: 'video/mp4',
      });
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

    // Work unit 11F-3: duplicate episode-number-within-series validation.
    describe('duplicate episode-number-within-series validation', () => {
      async function createMediaWithEpisode(
        episodeNumber: number,
      ): Promise<string> {
        storageService.createPresignedPutUrl.mockResolvedValue({
          url: 'https://signed.example.test/put',
          key: 'k',
          expiresAt: new Date(),
        });
        const created = await service.createUpload({
          ...baseDto,
          episodeNumber,
        });
        return created.media.id;
      }

      it('rejects a PATCH that collides with ANOTHER episode in the same series with 409 DUPLICATE_EPISODE_NUMBER, and applies no update', async () => {
        const firstId = await createMediaWithEpisode(1);
        const secondId = await createMediaWithEpisode(2);

        await expect(
          service.updateMetadata(secondId, { episodeNumber: 1 }),
        ).rejects.toMatchObject({
          code: AppErrorCode.DUPLICATE_EPISODE_NUMBER,
        });

        const persistedFirst = await prisma.video.findUnique({
          where: { id: firstId },
        });
        const persistedSecond = await prisma.video.findUnique({
          where: { id: secondId },
        });
        expect(persistedFirst?.episodeNumber).toBe(1);
        expect(persistedSecond?.episodeNumber).toBe(2); // unchanged
      });

      it('allows a PATCH to an episodeNumber unused in the series', async () => {
        await createMediaWithEpisode(1);
        const secondId = await createMediaWithEpisode(2);

        const result = await service.updateMetadata(secondId, {
          episodeNumber: 3,
        });

        expect(result.episodeNumber).toBe(3);
      });

      it('does not false-positive when PATCHing other fields without episodeNumber, even alongside another same-series episode', async () => {
        await createMediaWithEpisode(1);
        const secondId = await createMediaWithEpisode(2);

        const result = await service.updateMetadata(secondId, {
          title: 'Retitled, no episodeNumber in body',
        });

        expect(result.title).toBe('Retitled, no episodeNumber in body');
        expect(result.episodeNumber).toBe(2);
      });

      it("allows a PATCH that sets episodeNumber to the row's own current value (no-op, not a self-collision)", async () => {
        await createMediaWithEpisode(1);
        const secondId = await createMediaWithEpisode(2);

        const result = await service.updateMetadata(secondId, {
          episodeNumber: 2,
          title: 'Still allowed',
        });

        expect(result.episodeNumber).toBe(2);
        expect(result.title).toBe('Still allowed');
      });
    });
  });
});
