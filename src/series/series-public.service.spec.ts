import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AppErrorCode } from '../common/errors/app-error-code';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { DEFAULT_GET_URL_EXPIRY_SECONDS } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { PublicSeriesService } from './series-public.service';

const TEST_APP_CONFIG = {
  port: 3000,
  publicBaseUrl: 'http://localhost:3000',
  storageRoot: '/company/storage',
  corsOrigins: ['http://localhost:8081'],
};

/**
 * Work unit "SERIES METADATA + DISCOVER ARTWORK CONTRACT": integration-style
 * spec against the real test-database `PrismaService` (mirroring the
 * existing `SeriesService`/`VideosService`/`AdminMediaService` precedent),
 * with `StorageService` mocked (no real R2/network call — same pattern as
 * `videos.service.spec.ts`). Every fixture uses `testIdPrefix`-namespaced
 * ids so this suite never touches the 40 real seed rows or the 4 real
 * backfilled `Series` rows, and self-cleans in `afterEach`.
 */
describe('PublicSeriesService', () => {
  let service: PublicSeriesService;
  let prisma: PrismaService;
  let storageService: { createPresignedGetUrl: jest.Mock };

  const testIdPrefix = 'series-public-spec';

  async function createSeriesFixture(
    id: string,
    overrides: Partial<{
      title: string;
      coverImageKey: string | null;
      sortOrder: number;
      archivedAt: Date | null;
    }> = {},
  ): Promise<void> {
    await prisma.series.create({
      data: {
        id,
        title: overrides.title ?? `Fixture ${id}`,
        coverImageKey: overrides.coverImageKey ?? null,
        sortOrder: overrides.sortOrder ?? 0,
        archivedAt: overrides.archivedAt ?? null,
      },
    });
  }

  async function createVideoFixture(
    id: string,
    seriesId: string,
    overrides: Partial<{
      episodeNumber: number;
      category: string;
      sourceLanguage: string;
      likeCount: number;
      lifecycleState: string;
      contentKind: string;
      accessTierOverride: string | null;
    }> = {},
  ): Promise<void> {
    await prisma.video.create({
      data: {
        id,
        seriesId,
        title: `Fixture ${id}`,
        episodeNumber: overrides.episodeNumber ?? 1,
        channelName: 'Spec Channel',
        caption: 'Spec caption',
        category: overrides.category ?? 'drama',
        storageKey: '',
        sourceLanguage: overrides.sourceLanguage ?? 'zh',
        hasEmbeddedIndonesianSubtitle: true,
        likeCount: overrides.likeCount ?? 0,
        lifecycleState: overrides.lifecycleState ?? 'published',
        contentKind: overrides.contentKind ?? 'drama',
        accessTierOverride: overrides.accessTierOverride ?? null,
      },
    });
  }

  beforeEach(async () => {
    storageService = { createPresignedGetUrl: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PublicSeriesService,
        PrismaService,
        EntitlementsService,
        { provide: ConfigService, useValue: { get: () => TEST_APP_CONFIG } },
        { provide: StorageService, useValue: storageService },
      ],
    }).compile();

    service = module.get<PublicSeriesService>(PublicSeriesService);
    prisma = module.get<PrismaService>(PrismaService);
    await prisma.onModuleInit();
  });

  afterEach(async () => {
    await prisma.video.deleteMany({
      where: { seriesId: { startsWith: testIdPrefix } },
    });
    await prisma.series.deleteMany({
      where: { id: { startsWith: testIdPrefix } },
    });
    await prisma.onModuleDestroy();
  });

  describe('list', () => {
    it('returns an active series with truthful aggregates', async () => {
      const seriesId = `${testIdPrefix}-list-basic`;
      await createSeriesFixture(seriesId, { sortOrder: 1 });
      await createVideoFixture(`${seriesId}-ep1`, seriesId, {
        episodeNumber: 1,
        likeCount: 10,
      });
      await createVideoFixture(`${seriesId}-ep2`, seriesId, {
        episodeNumber: 2,
        likeCount: 7,
      });

      const { items } = await service.list();
      const item = items.find((i) => i.id === seriesId);

      expect(item).toMatchObject({
        id: seriesId,
        title: `Fixture ${seriesId}`,
        coverUrl: null,
        category: 'drama',
        sourceLanguage: 'zh',
        episodeCount: 2,
        totalLikes: 17,
        hasPremiumEpisodes: false,
      });
    });

    it('excludes archived series', async () => {
      const seriesId = `${testIdPrefix}-list-archived`;
      await createSeriesFixture(seriesId, { archivedAt: new Date() });
      await createVideoFixture(`${seriesId}-ep1`, seriesId);

      const { items } = await service.list();
      expect(items.find((i) => i.id === seriesId)).toBeUndefined();
    });

    it('excludes a series with zero Video rows at all', async () => {
      const seriesId = `${testIdPrefix}-list-empty`;
      await createSeriesFixture(seriesId);

      const { items } = await service.list();
      expect(items.find((i) => i.id === seriesId)).toBeUndefined();
    });

    it('excludes a series whose only episodes are qa_fixture (never leaks a public series for QA content)', async () => {
      const seriesId = `${testIdPrefix}-list-qa-only`;
      await createSeriesFixture(seriesId);
      await createVideoFixture(`${seriesId}-ep1`, seriesId, {
        contentKind: 'qa_fixture',
      });

      const { items } = await service.list();
      expect(items.find((i) => i.id === seriesId)).toBeUndefined();
    });

    it('excludes a series whose only episodes are unpublished (draft)', async () => {
      const seriesId = `${testIdPrefix}-list-draft-only`;
      await createSeriesFixture(seriesId);
      await createVideoFixture(`${seriesId}-ep1`, seriesId, {
        lifecycleState: 'draft',
      });

      const { items } = await service.list();
      expect(items.find((i) => i.id === seriesId)).toBeUndefined();
    });

    it('does not count a qa_fixture or draft sibling episode toward aggregates', async () => {
      const seriesId = `${testIdPrefix}-list-mixed`;
      await createSeriesFixture(seriesId);
      await createVideoFixture(`${seriesId}-ep1`, seriesId, {
        episodeNumber: 1,
        likeCount: 5,
      });
      await createVideoFixture(`${seriesId}-qa`, seriesId, {
        episodeNumber: 2,
        likeCount: 999,
        contentKind: 'qa_fixture',
      });
      await createVideoFixture(`${seriesId}-draft`, seriesId, {
        episodeNumber: 3,
        likeCount: 999,
        lifecycleState: 'draft',
      });

      const { items } = await service.list();
      const item = items.find((i) => i.id === seriesId);
      expect(item?.episodeCount).toBe(1);
      expect(item?.totalLikes).toBe(5);
    });

    it('reports category/sourceLanguage as null when qualifying episodes disagree, never guessing', async () => {
      const seriesId = `${testIdPrefix}-list-disagree`;
      await createSeriesFixture(seriesId);
      await createVideoFixture(`${seriesId}-ep1`, seriesId, {
        episodeNumber: 1,
        category: 'action',
        sourceLanguage: 'zh',
      });
      await createVideoFixture(`${seriesId}-ep2`, seriesId, {
        episodeNumber: 2,
        category: 'comedy',
        sourceLanguage: 'id',
      });

      const { items } = await service.list();
      const item = items.find((i) => i.id === seriesId);
      expect(item?.category).toBeNull();
      expect(item?.sourceLanguage).toBeNull();
    });

    it('reports hasPremiumEpisodes true when any qualifying episode is premium (accessTierOverride)', async () => {
      const seriesId = `${testIdPrefix}-list-premium-override`;
      await createSeriesFixture(seriesId);
      await createVideoFixture(`${seriesId}-ep1`, seriesId, {
        episodeNumber: 1,
        accessTierOverride: 'free',
      });
      await createVideoFixture(`${seriesId}-ep2`, seriesId, {
        episodeNumber: 2,
        accessTierOverride: 'premium',
      });

      const { items } = await service.list();
      const item = items.find((i) => i.id === seriesId);
      expect(item?.hasPremiumEpisodes).toBe(true);
    });

    it('reports hasPremiumEpisodes true from the default episodeNumber > FREE_EPISODE_LIMIT rule with no override', async () => {
      const seriesId = `${testIdPrefix}-list-premium-default`;
      await createSeriesFixture(seriesId);
      await createVideoFixture(`${seriesId}-ep1`, seriesId, {
        episodeNumber: 6,
      });

      const { items } = await service.list();
      const item = items.find((i) => i.id === seriesId);
      expect(item?.hasPremiumEpisodes).toBe(true);
    });

    it('resolves coverUrl via a presigned GET when coverImageKey is set, using DEFAULT_GET_URL_EXPIRY_SECONDS', async () => {
      const seriesId = `${testIdPrefix}-list-cover`;
      await createSeriesFixture(seriesId, {
        coverImageKey: 'series/cover.jpg',
      });
      await createVideoFixture(`${seriesId}-ep1`, seriesId);
      storageService.createPresignedGetUrl.mockResolvedValueOnce({
        url: 'https://r2.example.test/signed-cover-url',
        key: 'series/cover.jpg',
        expiresAt: new Date(),
      });

      const { items } = await service.list();
      const item = items.find((i) => i.id === seriesId);

      expect(item?.coverUrl).toBe('https://r2.example.test/signed-cover-url');
      expect(storageService.createPresignedGetUrl).toHaveBeenCalledWith(
        'series/cover.jpg',
        { expiresInSeconds: DEFAULT_GET_URL_EXPIRY_SECONDS },
      );
    });

    it('never calls createPresignedGetUrl when coverImageKey is null', async () => {
      const seriesId = `${testIdPrefix}-list-no-cover`;
      await createSeriesFixture(seriesId);
      await createVideoFixture(`${seriesId}-ep1`, seriesId);

      await service.list();

      expect(storageService.createPresignedGetUrl).not.toHaveBeenCalled();
    });

    it('orders results by sortOrder then id', async () => {
      const seriesB = `${testIdPrefix}-list-order-b`;
      const seriesA = `${testIdPrefix}-list-order-a`;
      await createSeriesFixture(seriesB, { sortOrder: 5 });
      await createSeriesFixture(seriesA, { sortOrder: 5 });
      await createVideoFixture(`${seriesB}-ep1`, seriesB);
      await createVideoFixture(`${seriesA}-ep1`, seriesA);

      const { items } = await service.list();
      const ids = items
        .map((i) => i.id)
        .filter((id) => id === seriesA || id === seriesB);
      expect(ids).toEqual([seriesA, seriesB]);
    });
  });

  describe('findById', () => {
    it('returns canonical metadata plus every qualifying episode, ordered by episodeNumber ascending', async () => {
      const seriesId = `${testIdPrefix}-detail-basic`;
      await createSeriesFixture(seriesId, { title: 'Detail Series' });
      await createVideoFixture(`${seriesId}-ep2`, seriesId, {
        episodeNumber: 2,
      });
      await createVideoFixture(`${seriesId}-ep1`, seriesId, {
        episodeNumber: 1,
      });

      const detail = await service.findById(seriesId);

      expect(detail.id).toBe(seriesId);
      expect(detail.title).toBe('Detail Series');
      expect(detail.episodes.map((e) => e.episodeNumber)).toEqual([1, 2]);
    });

    it('embedded episodes match the public VideoResponseDto shape (no admin-only fields, correct playbackUrl)', async () => {
      const seriesId = `${testIdPrefix}-detail-shape`;
      await createSeriesFixture(seriesId);
      await createVideoFixture(`${seriesId}-ep1`, seriesId, {
        episodeNumber: 1,
      });

      const detail = await service.findById(seriesId);
      const episode = detail.episodes[0];

      expect(episode).not.toHaveProperty('accessTierOverride');
      expect(episode).not.toHaveProperty('coverImageKey');
      expect(episode.playbackUrl).toBe(
        `${TEST_APP_CONFIG.publicBaseUrl}/videos/${seriesId}-ep1/stream`,
      );
    });

    it('excludes qa_fixture and draft episodes from the episodes array', async () => {
      const seriesId = `${testIdPrefix}-detail-mixed`;
      await createSeriesFixture(seriesId);
      await createVideoFixture(`${seriesId}-ep1`, seriesId, {
        episodeNumber: 1,
      });
      await createVideoFixture(`${seriesId}-qa`, seriesId, {
        episodeNumber: 2,
        contentKind: 'qa_fixture',
      });
      await createVideoFixture(`${seriesId}-draft`, seriesId, {
        episodeNumber: 3,
        lifecycleState: 'draft',
      });

      const detail = await service.findById(seriesId);
      expect(detail.episodes.map((e) => e.id)).toEqual([`${seriesId}-ep1`]);
    });

    it('throws 404 SERIES_NOT_FOUND for a nonexistent id', async () => {
      await expect(
        service.findById(`${testIdPrefix}-detail-does-not-exist`),
      ).rejects.toMatchObject({
        code: AppErrorCode.SERIES_NOT_FOUND,
      });
    });

    it('throws 404 SERIES_NOT_FOUND for an archived series', async () => {
      const seriesId = `${testIdPrefix}-detail-archived`;
      await createSeriesFixture(seriesId, { archivedAt: new Date() });
      await createVideoFixture(`${seriesId}-ep1`, seriesId);

      await expect(service.findById(seriesId)).rejects.toMatchObject({
        code: AppErrorCode.SERIES_NOT_FOUND,
      });
    });

    it('throws 404 SERIES_NOT_FOUND for a series with zero qualifying episodes', async () => {
      const seriesId = `${testIdPrefix}-detail-no-episodes`;
      await createSeriesFixture(seriesId);

      await expect(service.findById(seriesId)).rejects.toMatchObject({
        code: AppErrorCode.SERIES_NOT_FOUND,
      });
    });
  });
});
