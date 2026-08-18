import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AppErrorCode } from '../common/errors/app-error-code';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { fixtureMarker } from '../common/testing/fixture-namespace.helpers';
import {
  createPresignedGetUrlMock,
  signedKeysMatching,
  syntheticSignedGetUrlFor,
} from '../common/testing/storage-mock.helpers';
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
 *
 * Series test-isolation slice — TWO isolation defects fixed here, both of
 * which made this file fail deterministically once the four real curated
 * `Series` rows in the developer database gained a non-null
 * `coverImageKey`:
 *
 *  1. `PublicSeriesService.list()` reads EVERY active `Series` row, not just
 *     this suite's fixtures. The bare `jest.fn()` mock had no default, so
 *     signing a real row's cover returned `undefined` and
 *     `resolveSeriesCoverUrl` threw `TypeError: Cannot read properties of
 *     undefined (reading 'url')` — all 12 `list` tests failed, none of them
 *     for a reason related to what it was testing. The mock now has a
 *     deterministic default for any key (`createPresignedGetUrlMock`), so
 *     the production "cover set -> sign it" branch stays fully exercised.
 *
 *  2. `testIdPrefix` was a hardcoded literal, identical in every git
 *     worktree of this repository — and every worktree points at the same
 *     `short_drama_dev` database. Two concurrent runs would collide on the
 *     fixture ids and delete each other's rows mid-test. It is now derived
 *     from the shared per-run `TEST_FIXTURE_NAMESPACE`
 *     (`fixture-namespace.helpers.ts`), the same mechanism the Auth family
 *     already uses.
 *
 * Consequently NO assertion in this file may be phrased over the whole
 * table (`not.toHaveBeenCalled()`, a global row count, "exactly N items"):
 * the only truthful statements are about rows this suite created.
 */
describe('PublicSeriesService', () => {
  let service: PublicSeriesService;
  let prisma: PrismaService;
  let storageService: { createPresignedGetUrl: jest.Mock };

  const testIdPrefix = fixtureMarker('series-public-spec');

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
    // Mock-override hygiene: a BRAND NEW mock per test, so a one-shot or
    // scoped override installed by one test (see the signing-failure test
    // below) cannot possibly leak into the next — a stronger guarantee than
    // resetting a shared mock in `afterEach`, and the reason no reset is
    // needed here. (The e2e suites build their mock once in `beforeAll` and
    // therefore DO reset it per test — see `resetPresignedGetUrlMock`.)
    storageService = { createPresignedGetUrl: createPresignedGetUrlMock() };

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

    /**
     * Deliberately NOT `mockResolvedValueOnce`. `list()` signs every active
     * series that has a cover, and the four real curated rows sort ahead of
     * this fixture — a one-shot value is consumed by whichever key is signed
     * FIRST, which is not this test's. The default mock derives the URL from
     * the key it is given, so this assertion is exact and order-independent.
     */
    it('resolves coverUrl via a presigned GET when coverImageKey is set, using DEFAULT_GET_URL_EXPIRY_SECONDS', async () => {
      const seriesId = `${testIdPrefix}-list-cover`;
      const coverKey = `admin-series/${seriesId}/cover/list-cover-uuid`;
      await createSeriesFixture(seriesId, { coverImageKey: coverKey });
      await createVideoFixture(`${seriesId}-ep1`, seriesId);

      const { items } = await service.list();
      const item = items.find((i) => i.id === seriesId);

      expect(item?.coverUrl).toBe(syntheticSignedGetUrlFor(coverKey));
      expect(storageService.createPresignedGetUrl).toHaveBeenCalledWith(
        coverKey,
        { expiresInSeconds: DEFAULT_GET_URL_EXPIRY_SECONDS },
      );
      // Signed exactly once, and only for THIS fixture's key.
      expect(
        signedKeysMatching(storageService.createPresignedGetUrl, testIdPrefix),
      ).toEqual([coverKey]);
    });

    /**
     * The narrowest truthful invariant is "no key of MINE was signed", not
     * "the mock was never called at all". The latter was a global assertion
     * over the whole `Series` table and started failing (`Received number of
     * calls: 4`) the moment the four real curated rows gained covers —
     * without any change to the behavior under test. Two fixtures in one
     * test, one with a cover and one without, prove the branch directly:
     * the signed set must be exactly the cover-bearing fixture's key.
     */
    it('signs only the cover-bearing series, never one whose coverImageKey is null', async () => {
      const withCoverId = `${testIdPrefix}-list-with-cover`;
      const withoutCoverId = `${testIdPrefix}-list-no-cover`;
      const coverKey = `admin-series/${withCoverId}/cover/paired-uuid`;
      await createSeriesFixture(withCoverId, { coverImageKey: coverKey });
      await createVideoFixture(`${withCoverId}-ep1`, withCoverId);
      await createSeriesFixture(withoutCoverId);
      await createVideoFixture(`${withoutCoverId}-ep1`, withoutCoverId);

      const { items } = await service.list();

      expect(items.find((i) => i.id === withoutCoverId)?.coverUrl).toBeNull();
      expect(items.find((i) => i.id === withCoverId)?.coverUrl).toBe(
        syntheticSignedGetUrlFor(coverKey),
      );
      expect(
        signedKeysMatching(storageService.createPresignedGetUrl, testIdPrefix),
      ).toEqual([coverKey]);
    });

    /**
     * Series test-isolation slice, documented cover-signing failure
     * behavior: `resolveSeriesCoverUrl` does NOT swallow a storage error, so
     * a signing failure propagates out of `list()` rather than silently
     * degrading `coverUrl` to `null`. Recorded here so the contract is
     * explicit and any future change to it is a deliberate, visible one.
     */
    it('propagates a storage signing failure rather than silently reporting coverUrl null', async () => {
      const seriesId = `${testIdPrefix}-list-cover-signing-fails`;
      const coverKey = `admin-series/${seriesId}/cover/failing-uuid`;
      await createSeriesFixture(seriesId, { coverImageKey: coverKey });
      await createVideoFixture(`${seriesId}-ep1`, seriesId);
      // Scoped override: only THIS suite's key fails; every unrelated row
      // still resolves through the default, so the failure under test is the
      // only one in play.
      storageService.createPresignedGetUrl.mockImplementation((key: string) =>
        key === coverKey
          ? Promise.reject(new Error('presign failed'))
          : Promise.resolve({
              url: syntheticSignedGetUrlFor(key),
              key,
              expiresAt: new Date(0),
            }),
      );

      await expect(service.list()).rejects.toThrow('presign failed');
    });

    /**
     * An archived series is excluded from the public catalog outright, so
     * its cover is never signed — the archived check happens before any
     * signing, and having a cover does not change that.
     */
    it('never signs the cover of an archived series (it is excluded before signing)', async () => {
      const seriesId = `${testIdPrefix}-list-archived-with-cover`;
      const coverKey = `admin-series/${seriesId}/cover/archived-uuid`;
      await createSeriesFixture(seriesId, {
        coverImageKey: coverKey,
        archivedAt: new Date(),
      });
      await createVideoFixture(`${seriesId}-ep1`, seriesId);

      const { items } = await service.list();

      expect(items.find((i) => i.id === seriesId)).toBeUndefined();
      expect(
        signedKeysMatching(storageService.createPresignedGetUrl, testIdPrefix),
      ).toEqual([]);
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

    /**
     * Work unit "Episode Access-Tier + Category Contract Hardening":
     * per-episode `accessTier` (on each embedded `VideoResponseDto`) must
     * agree with the series-level `hasPremiumEpisodes` aggregate — both are
     * computed from the SAME `resolveAccessTier` rule, so an early episode
     * explicitly overridden premium must show up as `accessTier: 'premium'`
     * on its own DTO AND flip the series aggregate to `true`; a late episode
     * explicitly overridden free must show `accessTier: 'free'` and, if it
     * is the only episode, leave the aggregate `false`.
     */
    it('an early episode overridden premium: its own accessTier is "premium" and hasPremiumEpisodes is true', async () => {
      const seriesId = `${testIdPrefix}-detail-early-premium-override`;
      await createSeriesFixture(seriesId);
      await createVideoFixture(`${seriesId}-ep1`, seriesId, {
        episodeNumber: 1,
        accessTierOverride: 'premium',
      });

      const detail = await service.findById(seriesId);

      expect(detail.episodes[0].accessTier).toBe('premium');
      expect(detail.hasPremiumEpisodes).toBe(true);
    });

    it('a late episode overridden free: its own accessTier is "free" and hasPremiumEpisodes stays false', async () => {
      const seriesId = `${testIdPrefix}-detail-late-free-override`;
      await createSeriesFixture(seriesId);
      await createVideoFixture(`${seriesId}-ep1`, seriesId, {
        episodeNumber: 6,
        accessTierOverride: 'free',
      });

      const detail = await service.findById(seriesId);

      expect(detail.episodes[0].accessTier).toBe('free');
      expect(detail.hasPremiumEpisodes).toBe(false);
    });
  });
});
