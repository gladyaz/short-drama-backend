import { Test, TestingModule } from '@nestjs/testing';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { SeriesService } from './series.service';

/**
 * Phase 11, work unit 11E-4: `PrismaService` is the real client against the
 * project's Postgres test database (following the existing
 * `AdminMediaService`/`EntitlementsService` integration-style precedent),
 * self-cleaning via `afterEach`. No `StorageService`/filesystem/network
 * dependency exists for this service — a `Series` row is pure metadata.
 */
describe('SeriesService', () => {
  let service: SeriesService;
  let prisma: PrismaService;

  const testIdPrefix = 'series-spec-11e4';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SeriesService, PrismaService],
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
});
