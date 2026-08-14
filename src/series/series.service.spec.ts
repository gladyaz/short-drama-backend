import { Test, TestingModule } from '@nestjs/testing';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_GET_URL_EXPIRY_SECONDS } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { MAX_SERIES_COVER_UPLOAD_BYTES } from './series-cover.constants';
import { SeriesService } from './series.service';

/**
 * Phase 11, work unit 11E-4: `PrismaService` is the real client against the
 * project's Postgres test database (following the existing
 * `AdminMediaService`/`EntitlementsService` integration-style precedent),
 * self-cleaning via `afterEach`.
 *
 * Work unit "SERIES COVER UPLOAD BACKEND CONTRACT": `StorageService` is
 * mocked (mirroring `AdminMediaService`'s own spec precedent) — no test in
 * this file makes a real R2/S3 call.
 */
describe('SeriesService', () => {
  let service: SeriesService;
  let prisma: PrismaService;
  let storageService: {
    createPresignedPutUrl: jest.Mock;
    createPresignedGetUrl: jest.Mock;
    headObject: jest.Mock;
  };

  const testIdPrefix = 'series-spec-11e4';

  beforeEach(async () => {
    storageService = {
      // Echoes the real key back, mirroring `StorageService
      // .createPresignedPutUrl`'s actual behavior (`key` in `key` out) —
      // several tests below rely on the returned `upload.key` being the
      // REAL server-generated key `SeriesService.createCoverUpload` built,
      // not a canned fixture value.
      createPresignedPutUrl: jest.fn().mockImplementation((key: string) =>
        Promise.resolve({
          url: 'https://signed.example.test/put',
          key,
          expiresAt: new Date('2026-01-01T00:00:10.000Z'),
        }),
      ),
      createPresignedGetUrl: jest.fn().mockImplementation((key: string) =>
        Promise.resolve({
          url: `https://signed.example.test/get?key=${encodeURIComponent(key)}`,
          key,
          expiresAt: new Date('2026-01-01T01:00:00.000Z'),
        }),
      ),
      headObject: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SeriesService,
        PrismaService,
        { provide: StorageService, useValue: storageService },
      ],
    }).compile();

    service = module.get<SeriesService>(SeriesService);
    prisma = module.get<PrismaService>(PrismaService);
    await prisma.onModuleInit();
  });

  afterEach(async () => {
    // Work unit 11F-1: `remove`'s tests create namespaced `Video` fixtures
    // (never the 40 seed rows) to exercise the published-episode guard —
    // clean those up too, alongside the `Series` rows every describe block
    // already creates.
    await prisma.video.deleteMany({
      where: { id: { startsWith: testIdPrefix } },
    });
    await prisma.series.deleteMany({
      where: { id: { startsWith: testIdPrefix } },
    });
    await prisma.onModuleDestroy();
  });

  async function createVideoFixture(
    id: string,
    seriesId: string,
    lifecycleState: string,
  ): Promise<void> {
    await prisma.video.create({
      data: {
        id,
        seriesId,
        title: `Fixture ${id}`,
        episodeNumber: 1,
        channelName: 'Spec Channel',
        caption: 'Spec fixture caption',
        category: 'drama',
        storageKey: '',
        sourceLanguage: 'zh',
        hasEmbeddedIndonesianSubtitle: true,
        likeCount: 0,
        lifecycleState,
      },
    });
  }

  describe('create', () => {
    it('creates a series and returns a SeriesDto', async () => {
      const id = `${testIdPrefix}-create-basic`;

      const result = await service.create({ id, title: 'My Series' });

      expect(result).toMatchObject({
        id,
        title: 'My Series',
        coverImageKey: null,
        sortOrder: 0,
      });
      expect(typeof result.createdAt).toBe('string');
      expect(typeof result.updatedAt).toBe('string');

      const persisted = await prisma.series.findUnique({ where: { id } });
      expect(persisted).not.toBeNull();
    });

    it('persists optional coverImageKey and sortOrder when provided', async () => {
      const id = `${testIdPrefix}-create-optional`;

      const result = await service.create({
        id,
        title: 'My Series',
        coverImageKey: 'series/cover.jpg',
        sortOrder: 5,
      });

      expect(result.coverImageKey).toBe('series/cover.jpg');
      expect(result.sortOrder).toBe(5);
    });

    it('rejects a duplicate id with a clean 409 AppException, not a raw DB error', async () => {
      const id = `${testIdPrefix}-create-dup`;
      await service.create({ id, title: 'First' });

      let caught: unknown;
      try {
        await service.create({ id, title: 'Second' });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AppException);
      expect((caught as AppException).code).toBe(
        AppErrorCode.SERIES_ALREADY_EXISTS,
      );
      expect((caught as AppException).getStatus()).toBe(409);

      // The original row is untouched.
      const persisted = await prisma.series.findUnique({ where: { id } });
      expect(persisted?.title).toBe('First');
    });
  });

  describe('list', () => {
    it('returns created rows ordered by sortOrder then id', async () => {
      const seriesA = `${testIdPrefix}-list-b-tiebreak`;
      const seriesB = `${testIdPrefix}-list-a-tiebreak`;
      const seriesC = `${testIdPrefix}-list-first`;

      // Same sortOrder (0) for A and B — tie-break falls back to id asc.
      await service.create({ id: seriesA, title: 'A' });
      await service.create({ id: seriesB, title: 'B' });
      // Lower sortOrder, sorts first regardless of id.
      await service.create({ id: seriesC, title: 'C', sortOrder: -5 });

      const result = await service.list();
      const ids = result
        .filter((s) => s.id.startsWith(testIdPrefix))
        .map((s) => s.id);

      expect(ids).toEqual([seriesC, seriesB, seriesA]);
    });

    it('returns an empty array when no series exist', async () => {
      const result = await service.list();
      const matching = result.filter((s) => s.id.startsWith(testIdPrefix));
      expect(matching).toEqual([]);
    });

    it('excludes archived series by default (work unit 11F-1)', async () => {
      const activeId = `${testIdPrefix}-list-archive-active`;
      const archivedId = `${testIdPrefix}-list-archive-archived`;
      await service.create({ id: activeId, title: 'Active' });
      await service.create({ id: archivedId, title: 'Archived' });
      await service.archive(archivedId);

      const result = await service.list();
      const ids = result
        .filter((s) => s.id.startsWith(testIdPrefix))
        .map((s) => s.id);

      expect(ids).toContain(activeId);
      expect(ids).not.toContain(archivedId);
    });

    it('includes archived series when includeArchived is true', async () => {
      const activeId = `${testIdPrefix}-list-includearchived-active`;
      const archivedId = `${testIdPrefix}-list-includearchived-archived`;
      await service.create({ id: activeId, title: 'Active' });
      await service.create({ id: archivedId, title: 'Archived' });
      await service.archive(archivedId);

      const result = await service.list({ includeArchived: true });
      const ids = result
        .filter((s) => s.id.startsWith(testIdPrefix))
        .map((s) => s.id);

      expect(ids).toContain(activeId);
      expect(ids).toContain(archivedId);
    });

    /**
     * Work unit "SERIES COVER UPLOAD BACKEND CONTRACT", acceptance
     * criterion 5: `GET /admin/series` exposes a signed `coverUrl`,
     * including for an archived AND an episode-less series (this service
     * never reads `Video` at all, so "episode-less" is simply the default
     * state of every fixture this whole spec file creates).
     */
    it('exposes null-honest coverUrl for a series with no coverImageKey', async () => {
      const id = `${testIdPrefix}-list-cover-null`;
      await service.create({ id, title: 'No Cover' });

      const result = await service.list();
      const found = result.find((s) => s.id === id);

      expect(found?.coverUrl).toBeNull();
      expect(storageService.createPresignedGetUrl).not.toHaveBeenCalled();
    });

    it('resolves a signed coverUrl via the mocked StorageService when coverImageKey is set', async () => {
      const id = `${testIdPrefix}-list-cover-set`;
      await service.create({
        id,
        title: 'Has Cover',
        coverImageKey: 'admin-series/x/cover/some-uuid',
      });

      const result = await service.list();
      const found = result.find((s) => s.id === id);

      expect(found?.coverUrl).toBe(
        'https://signed.example.test/get?key=admin-series%2Fx%2Fcover%2Fsome-uuid',
      );
      expect(storageService.createPresignedGetUrl).toHaveBeenCalledWith(
        'admin-series/x/cover/some-uuid',
        { expiresInSeconds: DEFAULT_GET_URL_EXPIRY_SECONDS },
      );
    });

    it('exposes coverUrl for an archived series too (includeArchived=true)', async () => {
      const id = `${testIdPrefix}-list-cover-archived`;
      await service.create({
        id,
        title: 'Archived With Cover',
        coverImageKey: 'admin-series/x/cover/archived-uuid',
      });
      await service.archive(id);

      const result = await service.list({ includeArchived: true });
      const found = result.find((s) => s.id === id);

      expect(found?.coverUrl).toContain('archived-uuid');
    });
  });

  describe('findById', () => {
    it('returns the SeriesDto for an existing series', async () => {
      const id = `${testIdPrefix}-findbyid-basic`;
      await service.create({ id, title: 'Findable' });

      const result = await service.findById(id);

      expect(result).toMatchObject({ id, title: 'Findable', archivedAt: null });
    });

    it('returns an archived series too (unlike the default list view)', async () => {
      const id = `${testIdPrefix}-findbyid-archived`;
      await service.create({ id, title: 'Archived Findable' });
      await service.archive(id);

      const result = await service.findById(id);

      expect(result.id).toBe(id);
      expect(result.archivedAt).not.toBeNull();
    });

    it('rejects an unknown id with 404 SERIES_NOT_FOUND', async () => {
      await expect(
        service.findById(`${testIdPrefix}-findbyid-does-not-exist`),
      ).rejects.toMatchObject({ code: AppErrorCode.SERIES_NOT_FOUND });
    });

    it('exposes null-honest coverUrl for an episode-less series with no coverImageKey', async () => {
      const id = `${testIdPrefix}-findbyid-cover-null`;
      await service.create({ id, title: 'No Cover Detail' });

      const result = await service.findById(id);

      expect(result.coverUrl).toBeNull();
    });

    it('resolves a signed coverUrl when coverImageKey is set', async () => {
      const id = `${testIdPrefix}-findbyid-cover-set`;
      await service.create({
        id,
        title: 'Has Cover Detail',
        coverImageKey: 'admin-series/x/cover/detail-uuid',
      });

      const result = await service.findById(id);

      expect(result.coverUrl).toContain('detail-uuid');
    });
  });

  describe('update', () => {
    it('updates provided fields and preserves the others', async () => {
      const id = `${testIdPrefix}-update-partial`;
      await service.create({
        id,
        title: 'Original Title',
        coverImageKey: 'series/original.jpg',
        sortOrder: 2,
      });

      const updated = await service.update(id, { title: 'New Title' });

      expect(updated.title).toBe('New Title');
      expect(updated.coverImageKey).toBe('series/original.jpg');
      expect(updated.sortOrder).toBe(2);
    });

    it('bumps updatedAt on a successful update', async () => {
      const id = `${testIdPrefix}-update-bump`;
      const created = await service.create({ id, title: 'Original' });

      await new Promise((resolve) => setTimeout(resolve, 10));
      const updated = await service.update(id, { title: 'Bumped' });

      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(
        new Date(created.updatedAt).getTime(),
      );
      expect(updated.createdAt).toBe(created.createdAt);
    });

    it('updates multiple fields at once', async () => {
      const id = `${testIdPrefix}-update-multi`;
      await service.create({ id, title: 'Original' });

      const updated = await service.update(id, {
        title: 'Multi Title',
        coverImageKey: 'series/multi.jpg',
        sortOrder: 9,
      });

      expect(updated).toMatchObject({
        id,
        title: 'Multi Title',
        coverImageKey: 'series/multi.jpg',
        sortOrder: 9,
      });
    });

    it('rejects an empty body with 400 EMPTY_SERIES_UPDATE', async () => {
      const id = `${testIdPrefix}-update-empty`;
      await service.create({ id, title: 'Original' });

      let caught: unknown;
      try {
        await service.update(id, {});
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AppException);
      expect((caught as AppException).code).toBe(
        AppErrorCode.EMPTY_SERIES_UPDATE,
      );

      const persisted = await prisma.series.findUnique({ where: { id } });
      expect(persisted?.title).toBe('Original'); // unchanged
    });

    it('rejects an unknown id with 404 SERIES_NOT_FOUND', async () => {
      await expect(
        service.update(`${testIdPrefix}-does-not-exist`, { title: 'X' }),
      ).rejects.toMatchObject({ code: AppErrorCode.SERIES_NOT_FOUND });
    });

    /**
     * Work unit "SERIES COVER UPLOAD BACKEND CONTRACT", acceptance
     * criterion 4: three distinct `coverImageKey` semantics —
     * `undefined` = unchanged, `null` = explicit clear, `string` =
     * existing set/replace behavior. Each gets its own test rather than
     * being folded together, since the whole point is that these three
     * inputs must NOT collapse to the same behavior.
     */
    describe('coverImageKey null/undefined/string semantics', () => {
      it('undefined (field omitted) leaves the existing coverImageKey unchanged', async () => {
        const id = `${testIdPrefix}-update-cover-undefined`;
        await service.create({
          id,
          title: 'Original',
          coverImageKey: 'series/keep-me.jpg',
        });

        const updated = await service.update(id, { title: 'Renamed' });

        expect(updated.coverImageKey).toBe('series/keep-me.jpg');
        const persisted = await prisma.series.findUnique({ where: { id } });
        expect(persisted?.coverImageKey).toBe('series/keep-me.jpg');
      });

      it('null explicitly clears an existing coverImageKey', async () => {
        const id = `${testIdPrefix}-update-cover-null`;
        await service.create({
          id,
          title: 'Original',
          coverImageKey: 'series/clear-me.jpg',
        });

        const updated = await service.update(id, { coverImageKey: null });

        expect(updated.coverImageKey).toBeNull();
        const persisted = await prisma.series.findUnique({ where: { id } });
        expect(persisted?.coverImageKey).toBeNull();
      });

      it('a string sets/replaces coverImageKey (existing behavior, unchanged)', async () => {
        const id = `${testIdPrefix}-update-cover-string`;
        await service.create({
          id,
          title: 'Original',
          coverImageKey: 'series/old.jpg',
        });

        const updated = await service.update(id, {
          coverImageKey: 'series/new.jpg',
        });

        expect(updated.coverImageKey).toBe('series/new.jpg');
        const persisted = await prisma.series.findUnique({ where: { id } });
        expect(persisted?.coverImageKey).toBe('series/new.jpg');
      });

      it('null alone satisfies the "at least one field" requirement (does not throw EMPTY_SERIES_UPDATE)', async () => {
        const id = `${testIdPrefix}-update-cover-null-only`;
        await service.create({
          id,
          title: 'Original',
          coverImageKey: 'series/solo-clear.jpg',
        });

        const updated = await service.update(id, { coverImageKey: null });

        expect(updated.coverImageKey).toBeNull();
        expect(updated.title).toBe('Original'); // untouched
      });
    });
  });

  describe('archive', () => {
    it('sets archivedAt to a non-null ISO timestamp', async () => {
      const id = `${testIdPrefix}-archive-basic`;
      await service.create({ id, title: 'To Archive' });

      const result = await service.archive(id);

      expect(result.archivedAt).not.toBeNull();
      expect(typeof result.archivedAt).toBe('string');

      const persisted = await prisma.series.findUnique({ where: { id } });
      expect(persisted?.archivedAt).not.toBeNull();
    });

    it('is idempotent: archiving an already-archived series returns it unchanged', async () => {
      const id = `${testIdPrefix}-archive-idempotent`;
      await service.create({ id, title: 'Idempotent' });
      const first = await service.archive(id);

      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = await service.archive(id);

      expect(second.archivedAt).toBe(first.archivedAt);
      expect(second.updatedAt).toBe(first.updatedAt);
    });

    it('rejects an unknown id with 404 SERIES_NOT_FOUND', async () => {
      await expect(
        service.archive(`${testIdPrefix}-archive-does-not-exist`),
      ).rejects.toMatchObject({ code: AppErrorCode.SERIES_NOT_FOUND });
    });
  });

  describe('unarchive', () => {
    it('clears archivedAt back to null', async () => {
      const id = `${testIdPrefix}-unarchive-basic`;
      await service.create({ id, title: 'To Unarchive' });
      await service.archive(id);

      const result = await service.unarchive(id);

      expect(result.archivedAt).toBeNull();

      const persisted = await prisma.series.findUnique({ where: { id } });
      expect(persisted?.archivedAt).toBeNull();
    });

    it('is idempotent: unarchiving an already-active series returns it unchanged', async () => {
      const id = `${testIdPrefix}-unarchive-idempotent`;
      const created = await service.create({ id, title: 'Never Archived' });

      const result = await service.unarchive(id);

      expect(result.archivedAt).toBeNull();
      expect(result.updatedAt).toBe(created.updatedAt);
    });

    it('rejects an unknown id with 404 SERIES_NOT_FOUND', async () => {
      await expect(
        service.unarchive(`${testIdPrefix}-unarchive-does-not-exist`),
      ).rejects.toMatchObject({ code: AppErrorCode.SERIES_NOT_FOUND });
    });
  });

  describe('remove (guarded hard delete)', () => {
    it('refuses with 409 SERIES_HAS_PUBLISHED_EPISODES when a published episode exists for that seriesId', async () => {
      const id = `${testIdPrefix}-remove-has-published`;
      const videoId = `${testIdPrefix}-remove-published-video`;
      await service.create({ id, title: 'Has Published Episode' });
      await createVideoFixture(videoId, id, 'published');

      let caught: unknown;
      try {
        await service.remove(id);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AppException);
      expect((caught as AppException).code).toBe(
        AppErrorCode.SERIES_HAS_PUBLISHED_EPISODES,
      );
      expect((caught as AppException).getStatus()).toBe(409);

      // Nothing was deleted or modified.
      const persistedSeries = await prisma.series.findUnique({
        where: { id },
      });
      expect(persistedSeries).not.toBeNull();
      const persistedVideo = await prisma.video.findUnique({
        where: { id: videoId },
      });
      expect(persistedVideo?.seriesId).toBe(id);
      expect(persistedVideo?.lifecycleState).toBe('published');
    });

    it('is allowed when no published episode exists (draft/unpublished episodes do not block it)', async () => {
      const id = `${testIdPrefix}-remove-no-published`;
      const draftVideoId = `${testIdPrefix}-remove-draft-video`;
      await service.create({ id, title: 'No Published Episode' });
      await createVideoFixture(draftVideoId, id, 'draft');

      await service.remove(id);

      const persistedSeries = await prisma.series.findUnique({
        where: { id },
      });
      expect(persistedSeries).toBeNull();

      // The unrelated (non-published) Video row and its seriesId are
      // completely unaffected by the Series delete — relationships are
      // preserved, `Video` is never touched.
      const persistedVideo = await prisma.video.findUnique({
        where: { id: draftVideoId },
      });
      expect(persistedVideo).not.toBeNull();
      expect(persistedVideo?.seriesId).toBe(id);
      expect(persistedVideo?.lifecycleState).toBe('draft');
    });

    it('is allowed when the series has no Video rows at all', async () => {
      const id = `${testIdPrefix}-remove-no-videos`;
      await service.create({ id, title: 'No Episodes' });

      await service.remove(id);

      const persisted = await prisma.series.findUnique({ where: { id } });
      expect(persisted).toBeNull();
    });

    it('rejects an unknown id with 404 SERIES_NOT_FOUND', async () => {
      await expect(
        service.remove(`${testIdPrefix}-remove-does-not-exist`),
      ).rejects.toMatchObject({ code: AppErrorCode.SERIES_NOT_FOUND });
    });
  });

  /**
   * Work unit "SERIES COVER UPLOAD BACKEND CONTRACT", acceptance criterion
   * 1. Guard/DTO-shape tests (401/403, MIME allow-list, size boundary via
   * `class-validator`) live at the HTTP layer (`test/series.e2e-spec.ts`) —
   * a service-level unit test bypasses the `ValidationPipe` entirely, so it
   * cannot exercise those. This layer covers the SERVICE's own logic.
   */
  describe('createCoverUpload', () => {
    const validDto = { contentType: 'image/jpeg', sizeBytes: 2048 };

    it('rejects an unknown series id with 404 SERIES_NOT_FOUND, never minting a presigned URL', async () => {
      await expect(
        service.createCoverUpload(
          `${testIdPrefix}-cover-init-does-not-exist`,
          validDto,
        ),
      ).rejects.toMatchObject({ code: AppErrorCode.SERIES_NOT_FOUND });

      expect(storageService.createPresignedPutUrl).not.toHaveBeenCalled();
    });

    it('mints a presigned PUT URL for a server-generated, series-scoped key', async () => {
      const id = `${testIdPrefix}-cover-init-basic`;
      await service.create({ id, title: 'Cover Init' });

      const result = await service.createCoverUpload(id, validDto);

      expect(result.upload.url).toBe('https://signed.example.test/put');
      expect(result.upload.key.startsWith(`admin-series/${id}/cover/`)).toBe(
        true,
      );
      expect(storageService.createPresignedPutUrl).toHaveBeenCalledTimes(1);
      expect(storageService.createPresignedPutUrl).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`^admin-series/${id}/cover/`)),
        { contentType: 'image/jpeg' },
      );
    });

    it('response shape is exactly { upload: { url, key, expiresAt } } — no series/media field, no credential leakage', async () => {
      const id = `${testIdPrefix}-cover-init-shape`;
      await service.create({ id, title: 'Shape' });

      const result = await service.createCoverUpload(id, validDto);

      expect(Object.keys(result)).toEqual(['upload']);
      expect(Object.keys(result.upload).sort()).toEqual([
        'expiresAt',
        'key',
        'url',
      ]);
      expect(typeof result.upload.expiresAt).toBe('string');
    });

    it('does NOT persist Series.coverImageKey on presign (acceptance criterion 1)', async () => {
      const id = `${testIdPrefix}-cover-init-no-persist`;
      await service.create({ id, title: 'No Persist' });

      await service.createCoverUpload(id, validDto);

      const persisted = await prisma.series.findUnique({ where: { id } });
      expect(persisted?.coverImageKey).toBeNull();
    });

    it('generates a distinct key on each call to the same series', async () => {
      const id = `${testIdPrefix}-cover-init-distinct`;
      await service.create({ id, title: 'Distinct' });

      const first = await service.createCoverUpload(id, validDto);
      const second = await service.createCoverUpload(id, validDto);

      expect(first.upload.key).not.toBe(second.upload.key);
    });
  });

  describe('completeCoverUpload', () => {
    const coverContentType = 'image/png';
    const coverSizeBytes = 4096;

    function mockHeadObjectFor(key: string, contentLength: number): void {
      storageService.headObject.mockResolvedValueOnce({
        key,
        contentLength,
        contentType: coverContentType,
      });
    }

    async function createSeriesWithMintedKey(
      idSuffix: string,
    ): Promise<{ id: string; key: string }> {
      const id = `${testIdPrefix}-${idSuffix}`;
      await service.create({ id, title: idSuffix });
      const initResult = await service.createCoverUpload(id, {
        contentType: coverContentType,
        sizeBytes: coverSizeBytes,
      });
      return { id, key: initResult.upload.key };
    }

    it('rejects an unknown series id with 404 SERIES_NOT_FOUND', async () => {
      await expect(
        service.completeCoverUpload(
          `${testIdPrefix}-cover-complete-does-not-exist`,
          {
            key: 'admin-series/whatever/cover/00000000-0000-4000-8000-000000000000',
          },
        ),
      ).rejects.toMatchObject({ code: AppErrorCode.SERIES_NOT_FOUND });
    });

    it('rejects a key belonging to a DIFFERENT series with 400 SERIES_COVER_KEY_INVALID, never calling headObject', async () => {
      const { id } = await createSeriesWithMintedKey(
        'cover-complete-wrong-owner',
      );
      const otherSeriesKey =
        'admin-series/some-other-series/cover/00000000-0000-4000-8000-000000000000';

      await expect(
        service.completeCoverUpload(id, { key: otherSeriesKey }),
      ).rejects.toMatchObject({
        code: AppErrorCode.SERIES_COVER_KEY_INVALID,
      });
      expect(storageService.headObject).not.toHaveBeenCalled();
    });

    it('rejects an admin-media/... object key with 400 SERIES_COVER_KEY_INVALID', async () => {
      const { id } = await createSeriesWithMintedKey(
        'cover-complete-media-key',
      );

      await expect(
        service.completeCoverUpload(id, {
          key: 'admin-media/media-abc/source',
        }),
      ).rejects.toMatchObject({
        code: AppErrorCode.SERIES_COVER_KEY_INVALID,
      });
      expect(storageService.headObject).not.toHaveBeenCalled();
    });

    it('rejects when the object does not exist (headObject returns null) with 400 MEDIA_FILE_NOT_FOUND, leaving coverImageKey untouched', async () => {
      const { id, key } = await createSeriesWithMintedKey(
        'cover-complete-missing-object',
      );
      storageService.headObject.mockResolvedValueOnce(null);

      await expect(
        service.completeCoverUpload(id, { key }),
      ).rejects.toMatchObject({ code: AppErrorCode.MEDIA_FILE_NOT_FOUND });

      const persisted = await prisma.series.findUnique({ where: { id } });
      expect(persisted?.coverImageKey).toBeNull();
    });

    it('rejects a disallowed content type (e.g. image/svg+xml) with 409 SERIES_COVER_CONTENT_TYPE_NOT_ALLOWED', async () => {
      const { id, key } = await createSeriesWithMintedKey(
        'cover-complete-bad-mime',
      );
      storageService.headObject.mockResolvedValueOnce({
        key,
        contentLength: coverSizeBytes,
        contentType: 'image/svg+xml',
      });

      await expect(
        service.completeCoverUpload(id, { key }),
      ).rejects.toMatchObject({
        code: AppErrorCode.SERIES_COVER_CONTENT_TYPE_NOT_ALLOWED,
      });

      const persisted = await prisma.series.findUnique({ where: { id } });
      expect(persisted?.coverImageKey).toBeNull();
    });

    it('rejects an object one byte over MAX_SERIES_COVER_UPLOAD_BYTES with 409 SERIES_COVER_SIZE_OUT_OF_BOUND', async () => {
      const { id, key } = await createSeriesWithMintedKey(
        'cover-complete-too-big',
      );
      mockHeadObjectFor(key, MAX_SERIES_COVER_UPLOAD_BYTES + 1);

      await expect(
        service.completeCoverUpload(id, { key }),
      ).rejects.toMatchObject({
        code: AppErrorCode.SERIES_COVER_SIZE_OUT_OF_BOUND,
      });
    });

    it('accepts an object at exactly MAX_SERIES_COVER_UPLOAD_BYTES (inclusive boundary)', async () => {
      const { id, key } = await createSeriesWithMintedKey(
        'cover-complete-at-max',
      );
      mockHeadObjectFor(key, MAX_SERIES_COVER_UPLOAD_BYTES);

      const result = await service.completeCoverUpload(id, { key });

      expect(result.coverImageKey).toBe(key);
    });

    it('rejects a zero-byte object with 409 SERIES_COVER_SIZE_OUT_OF_BOUND', async () => {
      const { id, key } = await createSeriesWithMintedKey(
        'cover-complete-zero-bytes',
      );
      mockHeadObjectFor(key, 0);

      await expect(
        service.completeCoverUpload(id, { key }),
      ).rejects.toMatchObject({
        code: AppErrorCode.SERIES_COVER_SIZE_OUT_OF_BOUND,
      });
    });

    it('persists Series.coverImageKey only after every check passes, and returns a signed coverUrl', async () => {
      const { id, key } = await createSeriesWithMintedKey(
        'cover-complete-success',
      );
      mockHeadObjectFor(key, coverSizeBytes);

      const result = await service.completeCoverUpload(id, { key });

      expect(result.coverImageKey).toBe(key);
      expect(result.coverUrl).toContain(encodeURIComponent(key));
      const persisted = await prisma.series.findUnique({ where: { id } });
      expect(persisted?.coverImageKey).toBe(key);
    });

    it('is idempotent: completing the same key twice succeeds both times with the same result', async () => {
      const { id, key } = await createSeriesWithMintedKey(
        'cover-complete-idempotent',
      );
      mockHeadObjectFor(key, coverSizeBytes);
      const first = await service.completeCoverUpload(id, { key });

      mockHeadObjectFor(key, coverSizeBytes);
      const second = await service.completeCoverUpload(id, { key });

      expect(second.coverImageKey).toBe(first.coverImageKey);
      const persisted = await prisma.series.findUnique({ where: { id } });
      expect(persisted?.coverImageKey).toBe(key);
    });

    /**
     * Acceptance criterion 3 (replace semantics): the OLD cover stays
     * authoritative until a NEW upload is independently verified; a failed
     * verification must never clear or partially overwrite it.
     */
    describe('replace semantics', () => {
      it('a failed re-upload verification leaves the existing (old) coverImageKey completely untouched', async () => {
        const { id, key: firstKey } = await createSeriesWithMintedKey(
          'cover-replace-fail-preserves-old',
        );
        mockHeadObjectFor(firstKey, coverSizeBytes);
        await service.completeCoverUpload(id, { key: firstKey });

        const secondInit = await service.createCoverUpload(id, {
          contentType: coverContentType,
          sizeBytes: coverSizeBytes,
        });
        storageService.headObject.mockResolvedValueOnce(null); // second upload never landed

        await expect(
          service.completeCoverUpload(id, { key: secondInit.upload.key }),
        ).rejects.toMatchObject({ code: AppErrorCode.MEDIA_FILE_NOT_FOUND });

        const persisted = await prisma.series.findUnique({ where: { id } });
        expect(persisted?.coverImageKey).toBe(firstKey); // unchanged
      });

      it('a successfully verified re-upload replaces the old coverImageKey with the new key', async () => {
        const { id, key: firstKey } = await createSeriesWithMintedKey(
          'cover-replace-success',
        );
        mockHeadObjectFor(firstKey, coverSizeBytes);
        await service.completeCoverUpload(id, { key: firstKey });

        const secondInit = await service.createCoverUpload(id, {
          contentType: coverContentType,
          sizeBytes: coverSizeBytes,
        });
        mockHeadObjectFor(secondInit.upload.key, coverSizeBytes);

        const result = await service.completeCoverUpload(id, {
          key: secondInit.upload.key,
        });

        expect(result.coverImageKey).toBe(secondInit.upload.key);
        expect(result.coverImageKey).not.toBe(firstKey);
        // The old object itself is never deleted by this flow — no
        // `StorageService.deleteObject` call exists anywhere in
        // `SeriesService` (orphan is documented, not auto-cleaned).
      });
    });

    /**
     * Fix cycle 1 (2026-08-15): closes a reviewer-reproduced HIGH finding —
     * a stale/replayed `complete` call carrying an OLD, already-superseded
     * key could previously silently succeed and revert a legitimate replace
     * or un-clear an explicit `PATCH { coverImageKey: null }`. These tests
     * reproduce BOTH scenarios and assert the new `Series.pendingCoverImageKey`
     * currency check rejects them with `409 SERIES_COVER_KEY_SUPERSEDED`
     * instead. (Non-vacuity of this describe block was proven by temporarily
     * reverting `SeriesService.createCoverUpload`/`completeCoverUpload` to
     * their pre-fix-cycle-1 logic and confirming every test below FAILS
     * against that reverted code, then restoring the fix byte-identical —
     * see the fix-cycle-1 report for the exact before/after diff and
     * failure output.)
     */
    describe('stale/replayed key rejection (fix cycle 1 — SERIES_COVER_KEY_SUPERSEDED)', () => {
      it('REPRO 1: rejects a replay of an old key after a legitimate replace, leaving the NEW cover untouched', async () => {
        const { id, key: firstKey } = await createSeriesWithMintedKey(
          'cover-replay-after-replace',
        );
        mockHeadObjectFor(firstKey, coverSizeBytes);
        await service.completeCoverUpload(id, { key: firstKey });

        const secondInit = await service.createCoverUpload(id, {
          contentType: coverContentType,
          sizeBytes: coverSizeBytes,
        });
        mockHeadObjectFor(secondInit.upload.key, coverSizeBytes);
        await service.completeCoverUpload(id, { key: secondInit.upload.key });

        // Replay the FIRST (now-superseded) key — this must never silently
        // revert the cover back to `firstKey`. Mocked as though the OLD
        // object still genuinely exists in storage (it is never deleted on
        // replace — see the "Orphan behavior" doc), so a rejection here can
        // only come from the currency check, not a missing-object 400.
        mockHeadObjectFor(firstKey, coverSizeBytes);
        await expect(
          service.completeCoverUpload(id, { key: firstKey }),
        ).rejects.toMatchObject({
          code: AppErrorCode.SERIES_COVER_KEY_SUPERSEDED,
        });

        const persisted = await prisma.series.findUnique({ where: { id } });
        expect(persisted?.coverImageKey).toBe(secondInit.upload.key);
        expect(persisted?.coverImageKey).not.toBe(firstKey);
      });

      it('REPRO 2: rejects a replay of a completed key after an explicit PATCH-null clear, leaving coverImageKey null', async () => {
        const { id, key } = await createSeriesWithMintedKey(
          'cover-replay-after-null-clear',
        );
        mockHeadObjectFor(key, coverSizeBytes);
        await service.completeCoverUpload(id, { key });

        await service.update(id, { coverImageKey: null });

        // Replay the just-cleared key — this must never silently "un-clear"
        // the cover. Mocked as though the object still genuinely exists in
        // storage (an explicit PATCH-null never deletes the R2 object,
        // only the pointer), so a rejection here can only come from the
        // currency check, not a missing-object 400.
        mockHeadObjectFor(key, coverSizeBytes);
        await expect(
          service.completeCoverUpload(id, { key }),
        ).rejects.toMatchObject({
          code: AppErrorCode.SERIES_COVER_KEY_SUPERSEDED,
        });

        const persisted = await prisma.series.findUnique({ where: { id } });
        expect(persisted?.coverImageKey).toBeNull();
      });

      it('same-key re-complete is still idempotent: a no-op success that never re-calls headObject', async () => {
        const { id, key } = await createSeriesWithMintedKey(
          'cover-idempotent-no-reverify',
        );
        mockHeadObjectFor(key, coverSizeBytes);
        await service.completeCoverUpload(id, { key });
        expect(storageService.headObject).toHaveBeenCalledTimes(1);

        const second = await service.completeCoverUpload(id, { key });

        expect(second.coverImageKey).toBe(key);
        // The idempotent branch short-circuits BEFORE any storage call —
        // call count stays at 1, not 2.
        expect(storageService.headObject).toHaveBeenCalledTimes(1);
      });

      it('presign overwrites pending: completing an older mint is rejected once a newer mint supersedes it', async () => {
        const id = `${testIdPrefix}-cover-mint-overwrite`;
        await service.create({ id, title: id });

        const firstInit = await service.createCoverUpload(id, {
          contentType: coverContentType,
          sizeBytes: coverSizeBytes,
        });
        const secondInit = await service.createCoverUpload(id, {
          contentType: coverContentType,
          sizeBytes: coverSizeBytes,
        });
        expect(secondInit.upload.key).not.toBe(firstInit.upload.key);

        await expect(
          service.completeCoverUpload(id, { key: firstInit.upload.key }),
        ).rejects.toMatchObject({
          code: AppErrorCode.SERIES_COVER_KEY_SUPERSEDED,
        });
        expect(storageService.headObject).not.toHaveBeenCalled();

        const persisted = await prisma.series.findUnique({ where: { id } });
        expect(persisted?.coverImageKey).toBeNull(); // never completed
        expect(persisted?.pendingCoverImageKey).toBe(secondInit.upload.key);
      });

      it('createCoverUpload persists the freshly minted key into pendingCoverImageKey, overwriting any prior pending value', async () => {
        const id = `${testIdPrefix}-cover-pending-overwrite`;
        await service.create({ id, title: id });

        const firstInit = await service.createCoverUpload(id, {
          contentType: coverContentType,
          sizeBytes: coverSizeBytes,
        });
        const afterFirst = await prisma.series.findUnique({ where: { id } });
        expect(afterFirst?.pendingCoverImageKey).toBe(firstInit.upload.key);

        const secondInit = await service.createCoverUpload(id, {
          contentType: coverContentType,
          sizeBytes: coverSizeBytes,
        });
        const afterSecond = await prisma.series.findUnique({ where: { id } });
        expect(afterSecond?.pendingCoverImageKey).toBe(secondInit.upload.key);
        expect(afterSecond?.pendingCoverImageKey).not.toBe(
          firstInit.upload.key,
        );
      });

      it('PATCH { coverImageKey: null } also clears pendingCoverImageKey', async () => {
        const id = `${testIdPrefix}-cover-null-clears-pending`;
        await service.create({ id, title: id });
        await service.createCoverUpload(id, {
          contentType: coverContentType,
          sizeBytes: coverSizeBytes,
        });

        const beforeClear = await prisma.series.findUnique({ where: { id } });
        expect(beforeClear?.pendingCoverImageKey).not.toBeNull();

        await service.update(id, { coverImageKey: null });

        const afterClear = await prisma.series.findUnique({ where: { id } });
        expect(afterClear?.pendingCoverImageKey).toBeNull();
      });
    });
  });
});
