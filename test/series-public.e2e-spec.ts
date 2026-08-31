import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { StorageService } from './../src/storage/storage.service';
import { e2eSuiteBootBudgetMs } from './../src/common/testing/e2e-boot-budget.helpers';
import { fixtureMarker } from './../src/common/testing/fixture-namespace.helpers';
import {
  createPresignedGetUrlMock,
  resetPresignedGetUrlMock,
} from './../src/common/testing/storage-mock.helpers';
import { expectedSeriesCoverUrl } from './../src/common/testing/series-cover-expectation.helpers';
import type {
  SeriesDetailPublicDto,
  SeriesListResponseDto,
  SeriesPublicDto,
} from './../src/series/series-public.types';

interface ErrorResponseBody {
  statusCode: number;
  code: string;
  message: string;
}

/**
 * Series test-isolation slice. This suite's `beforeAll` boots the full Nest
 * `AppModule` and does nothing else — no authentication, no bcrypt — yet it
 * still exceeded Jest's inherited 5000ms default and failed all of its tests
 * at once whenever another Jest worker was booting at the same time. Cold
 * boot measures 2.6-4.3s per worker at worker-pool saturation, so a 5000ms
 * hook budget left as little as ~700ms of headroom.
 *
 * `e2eSuiteBootBudgetMs()` with no argument — the measured cold-boot budget
 * alone. A harness hang-detector budget, not a business timeout, and not a
 * substitute for real isolation fixes: the cover-signing and fixture-
 * namespace defects in this file were fixed at the source, not by widening a
 * window. See `src/common/testing/e2e-boot-budget.helpers.ts`.
 */
jest.setTimeout(e2eSuiteBootBudgetMs());

/**
 * e2e coverage for the work unit "SERIES METADATA + DISCOVER ARTWORK
 * CONTRACT" public, UNAUTHENTICATED catalog surface: `GET /series` and
 * `GET /series/:id`. Separate file from `test/series.e2e-spec.ts` (the
 * admin-guarded `/admin/series` suite), mirroring the existing
 * `videos.e2e-spec.ts` (public) vs `admin-media.e2e-spec.ts` (admin) split.
 * `StorageService` is mocked (same `.overrideProvider` pattern
 * `videos.e2e-spec.ts` already uses) — no real R2/network call.
 *
 * Series test-isolation slice, two fixes:
 *
 *  1. The `StorageService` mock was a bare `jest.fn()` with no default.
 *     `GET /series` signs the cover of EVERY active series that has one, so
 *     any cover-bearing row this suite did not create — a real curated row
 *     once `short_drama_test` is backfilled, or a fixture created by
 *     `series.e2e-spec.ts` in a PARALLEL Jest worker — resolved to
 *     `undefined` and turned the request into a 500. Latent here today only
 *     because `short_drama_test`'s four `Series` rows still have a null
 *     `coverImageKey`; it is the same defect that already broke
 *     `series-public.service.spec.ts` against the developer database. The
 *     mock now has a deterministic default for any key.
 *
 *  2. `idPrefix` was a hardcoded literal, identical in every worktree of
 *     this repository, all of which share `short_drama_test` — two
 *     concurrent runs collided on fixture ids. It is now derived from the
 *     shared per-run `TEST_FIXTURE_NAMESPACE`.
 */
describe('Public series catalog (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let mockStorageService: { createPresignedGetUrl: jest.Mock };

  const idPrefix = fixtureMarker('series-public-e2e-spec');

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
      lifecycleState: string;
      contentKind: string;
    }> = {},
  ): Promise<void> {
    await prisma.video.create({
      data: {
        id,
        seriesId,
        title: `Fixture ${id}`,
        episodeNumber: overrides.episodeNumber ?? 1,
        channelName: 'E2E Channel',
        caption: 'E2E fixture caption',
        category: 'drama',
        storageKey: '',
        sourceLanguage: 'zh',
        hasEmbeddedIndonesianSubtitle: true,
        likeCount: 1,
        lifecycleState: overrides.lifecycleState ?? 'published',
        contentKind: overrides.contentKind ?? 'drama',
      },
    });
  }

  beforeAll(async () => {
    mockStorageService = { createPresignedGetUrl: createPresignedGetUrlMock() };

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
  });

  afterEach(async () => {
    // This suite builds its mock ONCE in `beforeAll`, so an override
    // genuinely can leak into the next test. `mockClear` alone would leave
    // an unconsumed `mockResolvedValueOnce` queued; a bare `mockReset`
    // would strip the default implementation and make the mock return
    // `undefined` again.
    resetPresignedGetUrlMock(mockStorageService.createPresignedGetUrl);
    // Per-test cleanup (not just `afterAll`): several tests below create a
    // namespaced `Series`/`Video` fixture and then immediately call
    // `GET /series`, which re-evaluates EVERY active series, including any
    // fixture left over from a previous test. Cleaning up here keeps each
    // test isolated — a leftover fixture with a real `coverImageKey`
    // otherwise triggers an extra, unmocked `createPresignedGetUrl` call in
    // a LATER test.
    await prisma.video.deleteMany({
      where: { seriesId: { startsWith: idPrefix } },
    });
    await prisma.series.deleteMany({
      where: { id: { startsWith: idPrefix } },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /series', () => {
    it('requires no authentication', async () => {
      await request(app.getHttpServer()).get('/series').expect(HttpStatus.OK);
    });

    it('returns the response wrapped in an { items } envelope, not a bare array', async () => {
      const response = await request(app.getHttpServer())
        .get('/series')
        .expect(HttpStatus.OK);

      const body = response.body as SeriesListResponseDto;
      expect(Array.isArray(body.items)).toBe(true);
    });

    it('includes a real backfilled series with a truthful (non-fabricated) shape', async () => {
      const response = await request(app.getHttpServer())
        .get('/series')
        .expect(HttpStatus.OK);

      const body = response.body as SeriesListResponseDto;
      const series104 = body.items.find((item) => item.id === 'series-104');

      expect(series104).toBeDefined();
      expect(series104).toMatchObject({
        id: 'series-104',
        title: 'Malapetaka Datang: Benteng Bergerakku',
        episodeCount: 10,
      });
      // Nullable poster honesty: no cover art exists for the real backfilled
      // series (verified during the audit — 0/42 Video rows and 0/4 Series
      // rows carry a coverImageKey), so this must be null, never a
      // fabricated URL.
      expect(series104?.coverUrl).toBeNull();
      expect(series104).not.toHaveProperty('createdAt');
      expect(series104).not.toHaveProperty('coverImageKey');
    });

    it('excludes a series whose only episode is a qa_fixture (QA content never leaks a public series)', async () => {
      const seriesId = `${idPrefix}-list-qa-only`;
      await createSeriesFixture(seriesId);
      await createVideoFixture(`${seriesId}-ep1`, seriesId, {
        contentKind: 'qa_fixture',
      });

      const response = await request(app.getHttpServer())
        .get('/series')
        .expect(HttpStatus.OK);

      const body = response.body as SeriesListResponseDto;
      expect(body.items.find((item) => item.id === seriesId)).toBeUndefined();
    });

    it('excludes an archived series', async () => {
      const seriesId = `${idPrefix}-list-archived`;
      await createSeriesFixture(seriesId, { archivedAt: new Date() });
      await createVideoFixture(`${seriesId}-ep1`, seriesId);

      const response = await request(app.getHttpServer())
        .get('/series')
        .expect(HttpStatus.OK);

      const body = response.body as SeriesListResponseDto;
      expect(body.items.find((item) => item.id === seriesId)).toBeUndefined();
    });

    /**
     * Deliberately NOT `mockResolvedValueOnce`: `GET /series` signs every
     * cover-bearing active series, and a one-shot value goes to whichever
     * key is signed FIRST — which, with the real curated rows ordered ahead
     * of this fixture (and other suites' fixtures possibly present in a
     * parallel worker), is not necessarily this test's. The default mock
     * derives the URL from the key, so this assertion is exact and
     * order-independent.
     */
    it('resolves a usable coverUrl when an admin has set coverImageKey', async () => {
      const seriesId = `${idPrefix}-list-cover`;
      const coverKey = `admin-series/${seriesId}/cover/e2e-cover-uuid`;
      await createSeriesFixture(seriesId, { coverImageKey: coverKey });
      await createVideoFixture(`${seriesId}-ep1`, seriesId);

      const response = await request(app.getHttpServer())
        .get('/series')
        .expect(HttpStatus.OK);

      const body = response.body as SeriesListResponseDto;
      const item = body.items.find((i) => i.id === seriesId);
      // Exact, and correct under either storage driver — see
      // `expectedSeriesCoverUrl`. Under `local` (this repo's own `.env`) that
      // is this API's `/series/:id/cover` route; under `r2` it is the mocked
      // presigned GET this suite has always asserted.
      expect(item?.coverUrl).toBe(
        expectedSeriesCoverUrl(app, seriesId, coverKey),
      );
    });

    /**
     * Series test-isolation slice: the null-cover half of the same contract,
     * asserted on this suite's OWN fixture rather than on a global
     * `not.toHaveBeenCalled()` — which would be a claim about every other
     * row in the shared database, not about the behavior under test.
     */
    it('reports coverUrl null for a series with no coverImageKey', async () => {
      const seriesId = `${idPrefix}-list-no-cover`;
      await createSeriesFixture(seriesId);
      await createVideoFixture(`${seriesId}-ep1`, seriesId);

      const response = await request(app.getHttpServer())
        .get('/series')
        .expect(HttpStatus.OK);

      const body = response.body as SeriesListResponseDto;
      expect(body.items.find((i) => i.id === seriesId)?.coverUrl).toBeNull();
    });
  });

  /**
   * SEED DEPENDENCY — INTENTIONAL. Every test in this block asserts against
   * the REAL seeded `series-104` and its 10 real episodes, on purpose: it is
   * the contract test for the backfill migration's own output (canonical
   * title, episode count and ordering, per-episode `accessTier`). A locally
   * created fixture could not test that, so the prerequisite is documented
   * and verified explicitly rather than engineered away.
   *
   * PREREQUISITE: `short_drama_test` must be seeded and the `Series`
   * backfill migration applied (`DATABASE_URL=$DATABASE_URL_TEST npm run
   * db:seed`). Parallel-safe: no e2e suite creates `Video` rows under
   * `seriesId: 'series-104'` — `analytics`/`progress`/`export` reference the
   * id only inside their own event/progress rows, and every suite that does
   * create `Video` fixtures namespaces them under its own per-run
   * `TEST_FIXTURE_NAMESPACE`.
   */
  describe('GET /series/:id', () => {
    it('the seeded series-104 fixture this whole block depends on is present', async () => {
      const seeded = await prisma.series.findUnique({
        where: { id: 'series-104' },
      });
      const episodeCount = await prisma.video.count({
        where: {
          seriesId: 'series-104',
          lifecycleState: 'published',
          contentKind: 'drama',
        },
      });

      if (seeded === null || episodeCount === 0) {
        throw new Error(
          'short_drama_test is missing the seeded `series-104` catalog that ' +
            'this block asserts against. Run ' +
            '`DATABASE_URL=$DATABASE_URL_TEST npm run db:seed` and re-run.',
        );
      }
      expect(episodeCount).toBe(10);
    });

    it('requires no authentication', async () => {
      await request(app.getHttpServer())
        .get('/series/series-104')
        .expect(HttpStatus.OK);
    });

    it('returns canonical metadata plus every published drama episode, in VideoResponseDto shape', async () => {
      const response = await request(app.getHttpServer())
        .get('/series/series-104')
        .expect(HttpStatus.OK);

      const body = response.body as SeriesDetailPublicDto;
      expect(body).toMatchObject({
        id: 'series-104',
        title: 'Malapetaka Datang: Benteng Bergerakku',
        episodeCount: 10,
      });
      expect(body.episodes).toHaveLength(10);
      expect(body.episodes[0]).toMatchObject({
        seriesId: 'series-104',
        episodeNumber: 1,
      });
      expect(body.episodes[0]).not.toHaveProperty('accessTierOverride');
      expect(typeof body.episodes[0].playbackUrl).toBe('string');
      // Ascending by episodeNumber (intra-series order), not the
      // cross-series `sortOrder` `GET /videos/feed` uses.
      expect(body.episodes.map((e) => e.episodeNumber)).toEqual(
        Array.from({ length: 10 }, (_, i) => i + 1),
      );
    });

    /**
     * Work unit "Episode Access-Tier + Category Contract Hardening": every
     * embedded episode carries the ADDITIVE `accessTier` field, and the
     * series-level `hasPremiumEpisodes` aggregate agrees with it — proven
     * here against the REAL seeded `series-104` (episodes 1-5 free, 6-10
     * premium, per the 11F-4 backfill).
     */
    it('embedded episodes carry accessTier, agreeing with the series-level hasPremiumEpisodes aggregate', async () => {
      const response = await request(app.getHttpServer())
        .get('/series/series-104')
        .expect(HttpStatus.OK);

      const body = response.body as SeriesDetailPublicDto;
      expect(body.hasPremiumEpisodes).toBe(true);

      const byEpisodeNumber = new Map(
        body.episodes.map((e) => [e.episodeNumber, e.accessTier]),
      );
      expect(byEpisodeNumber.get(1)).toBe('free');
      expect(byEpisodeNumber.get(5)).toBe('free');
      expect(byEpisodeNumber.get(6)).toBe('premium');
      expect(byEpisodeNumber.get(10)).toBe('premium');
      expect(body.episodes.some((e) => e.accessTier === 'premium')).toBe(
        body.hasPremiumEpisodes,
      );
    });

    it('returns 404 SERIES_NOT_FOUND for an unknown id', async () => {
      const response = await request(app.getHttpServer())
        .get(`/series/${idPrefix}-does-not-exist`)
        .expect(HttpStatus.NOT_FOUND);

      expect((response.body as ErrorResponseBody).code).toBe(
        'SERIES_NOT_FOUND',
      );
    });

    it('returns 404 SERIES_NOT_FOUND for an archived series (public detail hides archived, unlike the admin route)', async () => {
      const seriesId = `${idPrefix}-detail-archived`;
      await createSeriesFixture(seriesId, { archivedAt: new Date() });
      await createVideoFixture(`${seriesId}-ep1`, seriesId);

      const response = await request(app.getHttpServer())
        .get(`/series/${seriesId}`)
        .expect(HttpStatus.NOT_FOUND);

      expect((response.body as ErrorResponseBody).code).toBe(
        'SERIES_NOT_FOUND',
      );
    });

    it('returns 404 SERIES_NOT_FOUND for a series whose only episode is a qa_fixture', async () => {
      const seriesId = `${idPrefix}-detail-qa-only`;
      await createSeriesFixture(seriesId);
      await createVideoFixture(`${seriesId}-ep1`, seriesId, {
        contentKind: 'qa_fixture',
      });

      const response = await request(app.getHttpServer())
        .get(`/series/${seriesId}`)
        .expect(HttpStatus.NOT_FOUND);

      expect((response.body as ErrorResponseBody).code).toBe(
        'SERIES_NOT_FOUND',
      );
    });
  });

  /**
   * Migration additivity / feed-compatibility: the pre-existing public
   * `GET /videos/feed` and `GET /videos/:id` are completely unaffected by
   * this work unit — no shared code path was changed in a way that alters
   * their output (the extracted `video-response.util.ts` functions are
   * byte-identical to the private methods they replaced, and
   * `video-response.util.spec.ts` covers them directly; `videos.service
   * .spec.ts`'s existing 46 tests are unchanged and still pass).
   */
  describe('migration additivity — /videos/feed untouched', () => {
    it('GET /videos/feed still serves the known seed video with its unchanged VideoResponseDto shape', async () => {
      const response = await request(app.getHttpServer())
        .get('/videos/feed')
        .expect(HttpStatus.OK);

      const feed = response.body as Array<Record<string, unknown>>;
      const known = feed.find((v) => v.id === 'video-104-01');

      expect(known).toBeDefined();
      expect(known).not.toHaveProperty('coverImageKey');
      expect(known?.seriesId).toBe('series-104');
    });
  });

  /**
   * Migration additivity: the data-only backfill migration
   * (`prisma/migrations/20260814142551_backfill_series_metadata`) created
   * exactly the 4 real `Series` rows without touching a single `Video`
   * row — verified here the same way `test/series.e2e-spec.ts`'s own
   * "migration additivity" block already verifies the `Video` table (a
   * specific known-row check, not a global count, since other e2e suites
   * run concurrently against the same test database).
   */
  describe('migration additivity — Series backfill', () => {
    it('created all 4 real series with their verified canonical titles', async () => {
      const response = await request(app.getHttpServer())
        .get('/series')
        .expect(HttpStatus.OK);

      const body = response.body as SeriesListResponseDto;
      const byId = new Map<string, SeriesPublicDto>(
        body.items.map((item) => [item.id, item]),
      );

      expect(byId.get('series-104')?.title).toBe(
        'Malapetaka Datang: Benteng Bergerakku',
      );
      expect(byId.get('series-010')?.title).toBe(
        'Kue Gulung Kaya Raya: Kedaiku Menembus Waktu',
      );
      expect(byId.get('series-101')?.title).toBe(
        'Hidup Bahagiaku Bersama Sang Permaisuri',
      );
      expect(byId.get('series-105')?.title).toBe(
        'Hati Yin yang Jahat: Antagonis Serang Habis-habisan',
      );
    });

    /**
     * SEED DEPENDENCY — INTENTIONAL, AND THE ONLY ONE LEFT IN THIS FILE.
     *
     * This assertion is a migration-additivity check: it exists precisely to
     * prove the seeded catalog is exactly the 40 rows the seed script
     * creates, so a data migration that silently added or dropped one would
     * be caught. Replacing it with a locally-created fixture would delete
     * the only thing it tests, so the prerequisite is documented and
     * verified explicitly instead.
     *
     * PREREQUISITE: `short_drama_test` must be seeded (`DATABASE_URL=
     * $DATABASE_URL_TEST npm run db:seed`). Parallel-safe: `video-` is the
     * seed script's own id prefix and no test suite creates ids under it —
     * every suite namespaces its `Video` fixtures (`videos.e2e-spec.ts` and
     * `series*.e2e-spec.ts` under their per-run `TEST_FIXTURE_NAMESPACE`,
     * `admin-media.e2e-spec.ts` under the service's `media-` prefix), so a
     * concurrent worker cannot move this number.
     */
    it('the 40-video seed catalog is untouched by the Series backfill', async () => {
      const seedVideoCount = await prisma.video.count({
        where: { id: { startsWith: 'video-' } },
      });

      if (seedVideoCount === 0) {
        throw new Error(
          'short_drama_test contains no `video-` seed rows: this migration-' +
            'additivity check needs the seeded catalog. Run ' +
            '`DATABASE_URL=$DATABASE_URL_TEST npm run db:seed` and re-run.',
        );
      }
      expect(seedVideoCount).toBe(40);
    });
  });
});
