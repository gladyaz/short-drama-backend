import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { StorageService } from './../src/storage/storage.service';
import { VideoContentKind } from './../src/videos/video-content-kind.types';
import type { AuthResponseDto } from './../src/auth/auth.types';
import {
  deriveAccessTier,
  FREE_EPISODE_LIMIT,
} from './../src/entitlements/entitlement.constants';
import { VIDEOS } from './../src/videos/videos.data';
import type {
  HlsPlaybackResponseDto,
  VideoPlaybackResponseDto,
  VideoResponseDto,
} from './../src/videos/video.types';
import * as hlsPlaybackTokenUtil from './../src/transcode/hls/hls-playback-token.util';
import { e2eSuiteBootBudgetMs } from './../src/common/testing/e2e-boot-budget.helpers';

interface ErrorResponseBody {
  statusCode: number;
  code: string;
  message: string;
}

/**
 * Slice 11Q — this file's `beforeAll` compiles ONE shared `AppModule`
 * instance for every test below, so the HLS gateway config (only consulted
 * by the dedicated HLS describe block further down; every other test below
 * is a non-HLS row and never touches it) must be set BEFORE that
 * compilation happens — i.e. at module-evaluation time, before Jest even
 * registers `describe`/`beforeAll`. This is a SYNTHETIC, test-only value —
 * the real `.env` file deliberately has NEITHER of these set (see
 * `.env.example`'s Slice 11Q section: "do not generate/store any real
 * secret; local .env gets nothing this slice — the flag is off; nothing
 * mints"). `TRANSCODE_ENABLED` stays whatever the real environment has it
 * as (`false`) — this does not turn transcoding on; it only lets THIS
 * file's HLS-ready test fixtures (created directly via `prisma.video.create`,
 * never through the real transcode pipeline) exercise a configured gateway.
 */
process.env.HLS_GATEWAY_BASE_URL = 'https://hls-gateway.e2e-test.internal';
process.env.HLS_TOKEN_SECRET = 'videos-e2e-spec-synthetic-hls-token-secret';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let accessToken: string;
  let userId: string;
  let mockStorageService: {
    createPresignedGetUrl: jest.Mock;
  };

  const emailPrefix = 'videos-e2e-spec+10b3';
  const freeEpisodeId = 'video-104-01';
  const premiumEpisodeId = 'video-104-06';
  const uniqueEmail = (label: string): string =>
    `${emailPrefix}-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  beforeAll(async () => {
    // Phase 11, work unit 11M: `StorageService` is mocked for this entire
    // file (mirroring `admin-media.e2e-spec.ts`'s existing pattern) — no
    // test here ever makes a real R2/S3 network call, including the new
    // `GET /videos/:id/playback` R2-backed-media tests below.
    mockStorageService = {
      createPresignedGetUrl: jest.fn(),
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

    const registerResponse = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: uniqueEmail('main'), password: 'correct-horse-battery' })
      .expect(HttpStatus.CREATED);

    const body = registerResponse.body as AuthResponseDto;
    accessToken = body.accessToken;
    userId = body.user.id;
  }, e2eSuiteBootBudgetMs(1));

  beforeEach(() => {
    mockStorageService.createPresignedGetUrl.mockClear();
  });

  afterAll(async () => {
    await prisma.entitlement.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({
      where: { email: { contains: emailPrefix } },
    });
    await app.close();
  });

  it('GET /health returns ok status', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(HttpStatus.OK);

    expect(response.body).toEqual({
      status: 'ok',
      service: 'short-drama-backend',
    });
  });

  it('GET /videos/feed returns at least three videos with a generated playbackUrl and no absolute storage path', async () => {
    const response = await request(app.getHttpServer())
      .get('/videos/feed')
      .expect(HttpStatus.OK);

    const videos = response.body as VideoResponseDto[];
    expect(Array.isArray(videos)).toBe(true);
    expect(videos.length).toBeGreaterThanOrEqual(3);

    const storageRoot = process.env.STORAGE_ROOT;
    const serialized = JSON.stringify(videos);
    if (storageRoot) {
      expect(serialized).not.toContain(storageRoot);
    }

    for (const video of videos) {
      expect(video.playbackUrl).toBe(
        `${process.env.PUBLIC_BASE_URL}/videos/${video.id}/stream`,
      );
      expect(video.hasEmbeddedIndonesianSubtitle).toBe(true);
      expect(video.storageKey.startsWith('/')).toBe(false);
    }
  });

  it('GET /videos/feed exposes an explicit contentKind on every row, consistent with GET /videos/:id', async () => {
    const feed = (
      await request(app.getHttpServer())
        .get('/videos/feed')
        .expect(HttpStatus.OK)
    ).body as VideoResponseDto[];

    expect(feed.length).toBeGreaterThan(0);

    for (const video of feed) {
      // Present on EVERY row - a client must never have to infer the
      // classification from title, channel, language or storage key.
      expect(video).toHaveProperty('contentKind');
      expect([VideoContentKind.DRAMA, VideoContentKind.QA_FIXTURE]).toContain(
        video.contentKind,
      );
    }

    // Real catalog rows are classified as drama by the column default, with
    // no per-row declaration needed.
    expect(
      feed.some((video) => video.contentKind === VideoContentKind.DRAMA),
    ).toBe(true);

    // The single-video endpoint must agree with the feed, or a client that
    // deep-links into a video would classify it differently from the list it
    // came from.
    const sample = feed[0];
    const single = (
      await request(app.getHttpServer())
        .get(`/videos/${sample.id}`)
        .expect(HttpStatus.OK)
    ).body as VideoResponseDto;

    expect(single.contentKind).toBe(sample.contentKind);
  });

  /**
   * Phase 11, work unit 11G-1: `VideosService.findAll` also excludes a
   * `published` row that has no playable source at all (empty `storageKey`
   * AND null `objectStorageKey`) — closing the 11B-3 placeholder-leak gap
   * (`lifecycleState: published` alone does not guarantee a real file). The
   * fixture below is created directly via `prisma.video.create` (mirroring
   * the 11E-3 `createOverrideFixture` pattern) with a uniquely prefixed
   * `id`/`seriesId` and removed in `afterAll`, so it never pollutes the
   * shared `short_drama_test` database beyond this describe block.
   */
  describe('GET /videos/feed — non-playable published rows (Phase 11, work unit 11G-1)', () => {
    const nonPlayableSeriesId = `${emailPrefix}-11g1-non-playable`;
    const nonPlayableId = `${nonPlayableSeriesId}-01`;

    afterAll(async () => {
      await prisma.video.deleteMany({
        where: { seriesId: nonPlayableSeriesId },
      });
    });

    it('returns exactly the 40 published seed rows and excludes a published row with no playable source', async () => {
      await prisma.video.create({
        data: {
          id: nonPlayableId,
          seriesId: nonPlayableSeriesId,
          title: 'Non-playable fixture',
          episodeNumber: 1,
          channelName: 'E2E Channel',
          caption: 'No playable source',
          category: 'drama',
          storageKey: '',
          sourceLanguage: 'zh',
          hasEmbeddedIndonesianSubtitle: true,
          likeCount: 0,
          lifecycleState: 'published',
          // objectStorageKey intentionally omitted -> defaults to null.
        },
      });

      const response = await request(app.getHttpServer())
        .get('/videos/feed')
        .expect(HttpStatus.OK);

      const videos = response.body as VideoResponseDto[];
      const videoIds = videos.map((video) => video.id);

      // The non-playable published row must never leak into the feed.
      expect(videoIds).not.toContain(nonPlayableId);

      // Every one of the 40 real seed rows is still present — their
      // storageKey has always been non-empty, so the new filter is a no-op
      // for them. Scoped to the known seed ids rather than the raw response
      // array length: other e2e spec files run concurrently in separate
      // Jest workers against the same `short_drama_test` database and may
      // have their own transient `published` fixtures in flight at the same
      // instant, which would make an assertion on the total array length
      // flaky.
      const seedIds = VIDEOS.map((video) => video.id);
      expect(seedIds).toHaveLength(40);
      const returnedSeedIds = videoIds.filter((id) => seedIds.includes(id));
      expect(returnedSeedIds).toHaveLength(40);
      expect(new Set(returnedSeedIds)).toEqual(new Set(seedIds));
    });
  });

  it('GET /videos/:id returns the matching video', async () => {
    const response = await request(app.getHttpServer())
      .get('/videos/video-104-01')
      .expect(HttpStatus.OK);

    const video = response.body as VideoResponseDto;
    expect(video.id).toBe('video-104-01');
  });

  it('GET /videos/:id returns a structured 404 for an unknown id', async () => {
    const response = await request(app.getHttpServer())
      .get('/videos/does-not-exist')
      .expect(HttpStatus.NOT_FOUND);

    expect(response.body).toEqual({
      statusCode: HttpStatus.NOT_FOUND,
      code: 'VIDEO_NOT_FOUND',
      message: 'Video not found',
    });
  });

  describe('GET /videos/:id/stream (Phase 10, work unit 10-B3)', () => {
    it('returns 401 for an unauthenticated request, even for a free episode', async () => {
      const response = await request(app.getHttpServer())
        .get(`/videos/${freeEpisodeId}/stream`)
        .expect(HttpStatus.UNAUTHORIZED);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('INVALID_ACCESS_TOKEN');
    });

    it('returns 206 Partial Content for an authenticated request to a free episode', async () => {
      const response = await request(app.getHttpServer())
        .get(`/videos/${freeEpisodeId}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Range', 'bytes=0-1023')
        .expect(HttpStatus.PARTIAL_CONTENT);

      expect(response.headers['content-range']).toMatch(/^bytes 0-1023\/\d+$/);
      expect(response.headers['accept-ranges']).toBe('bytes');
      expect(response.headers['content-type']).toBe('video/mp4');
    });

    it('returns 403 ENTITLEMENT_REQUIRED for an authenticated user with no entitlement requesting a premium episode', async () => {
      const response = await request(app.getHttpServer())
        .get(`/videos/${premiumEpisodeId}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.FORBIDDEN);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('ENTITLEMENT_REQUIRED');
    });

    it('returns 206 for a premium episode once the user is granted an entitlement', async () => {
      await prisma.entitlement.create({
        data: { userId, tier: 'premium', source: 'dev-grant' },
      });

      const response = await request(app.getHttpServer())
        .get(`/videos/${premiumEpisodeId}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Range', 'bytes=0-1023')
        .expect(HttpStatus.PARTIAL_CONTENT);

      expect(response.headers['content-range']).toMatch(/^bytes 0-1023\/\d+$/);

      await prisma.entitlement.deleteMany({ where: { userId } });
    });

    it('returns 403 again after the entitlement is revoked', async () => {
      const entitlement = await prisma.entitlement.create({
        data: { userId, tier: 'premium', source: 'dev-grant' },
      });
      await prisma.entitlement.update({
        where: { id: entitlement.id },
        data: { revokedAt: new Date() },
      });

      const response = await request(app.getHttpServer())
        .get(`/videos/${premiumEpisodeId}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.FORBIDDEN);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('ENTITLEMENT_REQUIRED');
    });

    it('returns 403 for an expired entitlement', async () => {
      await prisma.entitlement.create({
        data: {
          userId,
          tier: 'premium',
          source: 'dev-grant',
          expiresAt: new Date(Date.now() - 1000 * 60),
        },
      });

      const response = await request(app.getHttpServer())
        .get(`/videos/${premiumEpisodeId}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.FORBIDDEN);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('ENTITLEMENT_REQUIRED');

      await prisma.entitlement.deleteMany({ where: { userId } });
    });
  });

  /**
   * Work unit 11E-3: per-episode `accessTierOverride`. Fixtures are created
   * directly via `prisma.video.create` (mirroring `admin-media.e2e-spec.ts`'s
   * fixture pattern) with an empty `storageKey` — there is no real file on
   * disk for a synthetic id, so a request that gets PAST the entitlement gate
   * reaches `MEDIA_FILE_NOT_FOUND` (404) rather than 206, exactly the
   * "206 or a file-not-found" outcome the work unit's acceptance criteria
   * calls for. What matters for every assertion below is 403
   * (`ENTITLEMENT_REQUIRED`) vs. NOT 403 — the override's only real job is
   * deciding whether the entitlement gate applies at all.
   *
   * Setup for each override value uses direct `prisma.video.create`/`update`
   * calls, not the real `PATCH /admin/media/:id/access-tier` HTTP endpoint —
   * that endpoint's own request/response contract (guards, validation,
   * persistence) is independently covered end-to-end in
   * `test/admin-media.e2e-spec.ts`. Together the two files cover both halves
   * of the feature: does the admin endpoint correctly persist the override,
   * and does the stream guard correctly honor whatever is persisted.
   *
   * Work unit 11F-4: the "override" tests below (forced-premium,
   * forced-free, and the two clear-reverts-to-default cases) already prove,
   * unchanged, that enforcement reads `accessTierOverride` from the DB
   * rather than deriving purely from `episodeNumber` — a fixture whose DB
   * tier disagrees with what `episodeNumber` alone would derive gates
   * exactly per the DB value in every case. What changes in 11F-4 is only
   * what the 40 REAL pre-existing rows carry in that column by default: see
   * the first test below, updated from asserting `null` (pre-11F-4) to
   * asserting each row's explicit, correctly-derived tier (post-backfill).
   */
  describe('GET /videos/:id/stream — per-episode access-tier override (Phase 11, work unit 11E-3)', () => {
    const overrideSeriesId = `${emailPrefix}-11e3-override`;

    async function createOverrideFixture(
      idSuffix: string,
      episodeNumber: number,
      accessTierOverride: string | null,
    ): Promise<string> {
      const id = `${overrideSeriesId}-${idSuffix}`;
      await prisma.video.create({
        data: {
          id,
          seriesId: overrideSeriesId,
          title: `Override fixture ${id}`,
          episodeNumber,
          channelName: 'E2E Channel',
          caption: 'Override fixture caption',
          category: 'drama',
          storageKey: '',
          sourceLanguage: 'zh',
          hasEmbeddedIndonesianSubtitle: true,
          likeCount: 0,
          lifecycleState: 'published',
          accessTierOverride,
        },
      });
      return id;
    }

    afterAll(async () => {
      await prisma.video.deleteMany({
        where: { seriesId: overrideSeriesId },
      });
    });

    /**
     * Work unit 11F-4: supersedes the pre-11F-4 assertion that these rows
     * were `null`. A one-time additive backfill migration
     * (`prisma/migrations/*_backfill_video_access_tier_override`) filled
     * every pre-existing `NULL` `accessTierOverride` with the value the old
     * default rule (`isEpisodePremium`) already derived for it — so every
     * one of the 40 real seed rows now carries an EXPLICIT tier, not null.
     * This is the "behavior preservation" proof: for every seed row (none of
     * which has ever gone through the admin override endpoint), the stored
     * value must equal exactly what `deriveAccessTier` (the same boundary as
     * `isEpisodePremium`/`FREE_EPISODE_LIMIT`) computes from its
     * `episodeNumber` — i.e. the backfill changed WHAT IS STORED, never
     * WHAT THE GATING OUTCOME IS.
     */
    it('every one of the 40 pre-existing seed rows now carries an explicit accessTierOverride matching its derived value (11F-4 backfill)', async () => {
      const seedIds = VIDEOS.map((video) => video.id);
      expect(seedIds.length).toBe(40);

      const rows = await prisma.video.findMany({
        where: { id: { in: seedIds } },
        select: { id: true, episodeNumber: true, accessTierOverride: true },
      });
      expect(rows).toHaveLength(40);

      for (const row of rows) {
        expect(row.accessTierOverride).not.toBeNull();
        expect(row.accessTierOverride).toBe(
          deriveAccessTier(row.episodeNumber, FREE_EPISODE_LIMIT),
        );
      }

      const free = rows.find((row) => row.id === freeEpisodeId);
      const premium = rows.find((row) => row.id === premiumEpisodeId);
      expect(free?.accessTierOverride).toBe('free');
      expect(premium?.accessTierOverride).toBe('premium');
    });

    it('CRITICAL default-preserving: a free episode (episodeNumber <= FREE_EPISODE_LIMIT) with a null override still streams without an entitlement, exactly as today', async () => {
      const id = await createOverrideFixture('free-null', 1, null);

      const response = await request(app.getHttpServer())
        .get(`/videos/${id}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.NOT_FOUND); // no real file — but crucially NOT 403

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('MEDIA_FILE_NOT_FOUND');
    });

    it('CRITICAL default-preserving: a premium episode (episodeNumber > FREE_EPISODE_LIMIT) with a null override still requires an entitlement, exactly as today', async () => {
      const id = await createOverrideFixture('premium-null', 6, null);

      const response = await request(app.getHttpServer())
        .get(`/videos/${id}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.FORBIDDEN);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('ENTITLEMENT_REQUIRED');
    });

    it('override "premium" on an otherwise-free episode now requires an entitlement (403 without, past the gate with)', async () => {
      const id = await createOverrideFixture('forced-premium', 1, 'premium');

      const withoutEntitlement = await request(app.getHttpServer())
        .get(`/videos/${id}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.FORBIDDEN);
      expect((withoutEntitlement.body as ErrorResponseBody).code).toBe(
        'ENTITLEMENT_REQUIRED',
      );

      await prisma.entitlement.create({
        data: { userId, tier: 'premium', source: 'dev-grant' },
      });

      const withEntitlement = await request(app.getHttpServer())
        .get(`/videos/${id}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.NOT_FOUND); // past the entitlement gate, no real file
      expect((withEntitlement.body as ErrorResponseBody).code).toBe(
        'MEDIA_FILE_NOT_FOUND',
      );

      await prisma.entitlement.deleteMany({ where: { userId } });
    });

    it('override "free" on an otherwise-premium episode is streamable without an entitlement (gets past the 403)', async () => {
      const id = await createOverrideFixture('forced-free', 6, 'free');

      const response = await request(app.getHttpServer())
        .get(`/videos/${id}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.NOT_FOUND); // no entitlement, no real file — but crucially NOT 403

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('MEDIA_FILE_NOT_FOUND');
    });

    it('clearing the override (accessTierOverride -> null) reverts a premium-forced episode back to the default rule', async () => {
      const id = await createOverrideFixture('clear-reverts', 6, 'free');

      // sanity: the "free" override currently gets past the entitlement gate.
      const overridden = await request(app.getHttpServer())
        .get(`/videos/${id}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.NOT_FOUND);
      expect((overridden.body as ErrorResponseBody).code).toBe(
        'MEDIA_FILE_NOT_FOUND',
      );

      await prisma.video.update({
        where: { id },
        data: { accessTierOverride: null },
      });

      // reverted: episode 6 > FREE_EPISODE_LIMIT (5) -> premium again, per the
      // unchanged default rule.
      const reverted = await request(app.getHttpServer())
        .get(`/videos/${id}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.FORBIDDEN);
      expect((reverted.body as ErrorResponseBody).code).toBe(
        'ENTITLEMENT_REQUIRED',
      );
    });

    it('clearing the override reverts a free-forced episode back to streaming without an entitlement', async () => {
      const id = await createOverrideFixture(
        'clear-reverts-to-free',
        1,
        'premium',
      );

      // sanity: the "premium" override currently requires an entitlement.
      await request(app.getHttpServer())
        .get(`/videos/${id}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.FORBIDDEN);

      await prisma.video.update({
        where: { id },
        data: { accessTierOverride: null },
      });

      // reverted: episode 1 <= FREE_EPISODE_LIMIT (5) -> free again, per the
      // unchanged default rule.
      const reverted = await request(app.getHttpServer())
        .get(`/videos/${id}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.NOT_FOUND);
      expect((reverted.body as ErrorResponseBody).code).toBe(
        'MEDIA_FILE_NOT_FOUND',
      );
    });
  });

  /**
   * Work unit "Episode Access-Tier + Category Contract Hardening": the
   * ADDITIVE public `VideoResponseDto.accessTier` field, and proof that its
   * value agrees with the REAL stream/playback authorization decision (the
   * exact same `resolveAccessTier` rule behind
   * `EntitlementsService.resolveEpisodePremium`).
   */
  describe('VideoResponseDto.accessTier (Episode Access-Tier + Category Contract Hardening)', () => {
    const tierDtoSeriesId = `${emailPrefix}-tier-dto`;

    async function createTierDtoFixture(
      idSuffix: string,
      episodeNumber: number,
      accessTierOverride: string | null,
    ): Promise<string> {
      const id = `${tierDtoSeriesId}-${idSuffix}`;
      await prisma.video.create({
        data: {
          id,
          seriesId: tierDtoSeriesId,
          title: `Tier DTO fixture ${id}`,
          episodeNumber,
          channelName: 'E2E Channel',
          caption: 'Tier DTO fixture caption',
          category: 'drama',
          // Non-empty (but nonexistent-on-disk) storageKey, deliberately:
          // `GET /videos/feed` (work unit 11G-1) excludes any published row
          // with BOTH an empty storageKey AND no objectStorageKey, so an
          // empty key here would silently vanish from feed-based assertions
          // below. `/stream` still resolves to 404 MEDIA_FILE_NOT_FOUND for
          // this nonexistent path, exactly like the empty-key fixtures used
          // elsewhere in this file — no test here asserts 206.
          storageKey: `tier-dto-fixtures/${id}.mp4`,
          sourceLanguage: 'zh',
          hasEmbeddedIndonesianSubtitle: true,
          likeCount: 0,
          lifecycleState: 'published',
          accessTierOverride,
        },
      });
      return id;
    }

    afterAll(async () => {
      await prisma.video.deleteMany({ where: { seriesId: tierDtoSeriesId } });
    });

    it('GET /videos/feed and GET /videos/:id agree: free (episodeNumber <= FREE_EPISODE_LIMIT) matches the known free seed episode', async () => {
      const feed = (
        await request(app.getHttpServer())
          .get('/videos/feed')
          .expect(HttpStatus.OK)
      ).body as VideoResponseDto[];
      const feedItem = feed.find((v) => v.id === freeEpisodeId);
      expect(feedItem?.accessTier).toBe('free');
      expect(feedItem).not.toHaveProperty('accessTierOverride');

      const single = (
        await request(app.getHttpServer())
          .get(`/videos/${freeEpisodeId}`)
          .expect(HttpStatus.OK)
      ).body as VideoResponseDto;
      expect(single.accessTier).toBe('free');
      expect(single).not.toHaveProperty('accessTierOverride');
    });

    it('GET /videos/feed and GET /videos/:id agree: premium (episodeNumber > FREE_EPISODE_LIMIT) matches the known premium seed episode', async () => {
      const feed = (
        await request(app.getHttpServer())
          .get('/videos/feed')
          .expect(HttpStatus.OK)
      ).body as VideoResponseDto[];
      const feedItem = feed.find((v) => v.id === premiumEpisodeId);
      expect(feedItem?.accessTier).toBe('premium');

      const single = (
        await request(app.getHttpServer())
          .get(`/videos/${premiumEpisodeId}`)
          .expect(HttpStatus.OK)
      ).body as VideoResponseDto;
      expect(single.accessTier).toBe('premium');
    });

    it('explicit "free" override on a default-premium episode: DTO reports accessTier "free" AND is actually streamable without an entitlement', async () => {
      const id = await createTierDtoFixture('forced-free', 6, 'free');

      const single = (
        await request(app.getHttpServer())
          .get(`/videos/${id}`)
          .expect(HttpStatus.OK)
      ).body as VideoResponseDto;
      expect(single.accessTier).toBe('free');

      // The DTO's "free" claim must match reality: no entitlement, and the
      // gate lets it through (404 MEDIA_FILE_NOT_FOUND — no real file for a
      // synthetic fixture — never 403).
      const streamed = await request(app.getHttpServer())
        .get(`/videos/${id}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.NOT_FOUND);
      expect((streamed.body as ErrorResponseBody).code).toBe(
        'MEDIA_FILE_NOT_FOUND',
      );
    });

    it('explicit "premium" override on a default-free episode: DTO reports accessTier "premium" AND actually requires an entitlement to stream', async () => {
      const id = await createTierDtoFixture('forced-premium', 1, 'premium');

      const single = (
        await request(app.getHttpServer())
          .get(`/videos/${id}`)
          .expect(HttpStatus.OK)
      ).body as VideoResponseDto;
      expect(single.accessTier).toBe('premium');

      // The DTO's "premium" claim must match reality: denied without an
      // entitlement...
      const denied = await request(app.getHttpServer())
        .get(`/videos/${id}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.FORBIDDEN);
      expect((denied.body as ErrorResponseBody).code).toBe(
        'ENTITLEMENT_REQUIRED',
      );

      // ...and allowed (past the gate) once entitled.
      await prisma.entitlement.create({
        data: { userId, tier: 'premium', source: 'dev-grant' },
      });
      const allowed = await request(app.getHttpServer())
        .get(`/videos/${id}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.NOT_FOUND);
      expect((allowed.body as ErrorResponseBody).code).toBe(
        'MEDIA_FILE_NOT_FOUND',
      );
      await prisma.entitlement.deleteMany({ where: { userId } });
    });

    it('the same episode reports an identical accessTier on GET /videos/feed and GET /videos/:id (no drift between the two surfaces)', async () => {
      const id = await createTierDtoFixture('consistency', 6, null);

      const feed = (
        await request(app.getHttpServer())
          .get('/videos/feed')
          .expect(HttpStatus.OK)
      ).body as VideoResponseDto[];
      const feedItem = feed.find((v) => v.id === id);

      const single = (
        await request(app.getHttpServer())
          .get(`/videos/${id}`)
          .expect(HttpStatus.OK)
      ).body as VideoResponseDto;

      expect(feedItem?.accessTier).toBe('premium');
      expect(single.accessTier).toBe(feedItem?.accessTier);
    });
  });

  /**
   * Phase 11, work unit 11M (DECISIONS.md "Slice 11M approved..." entry,
   * Option A). `mockStorageService.createPresignedGetUrl` (declared/mocked
   * for the whole file in `beforeAll` above) is the ONLY thing standing in
   * for R2 — no test below makes a real network call.
   */
  describe('GET /videos/:id/playback (Phase 11, work unit 11M)', () => {
    const playbackSeriesId = `${emailPrefix}-11m-playback`;
    let fixtureCounter = 0;

    async function createFixture(overrides: {
      lifecycleState: string;
      episodeNumber?: number;
      storageKey?: string;
      objectStorageKey?: string | null;
      accessTierOverride?: string | null;
    }): Promise<string> {
      fixtureCounter += 1;
      const id = `${playbackSeriesId}-${fixtureCounter}`;
      await prisma.video.create({
        data: {
          id,
          seriesId: playbackSeriesId,
          title: `Playback fixture ${id}`,
          episodeNumber: overrides.episodeNumber ?? 1,
          channelName: 'E2E Channel',
          caption: 'Playback fixture caption',
          category: 'drama',
          storageKey: overrides.storageKey ?? '',
          sourceLanguage: 'zh',
          hasEmbeddedIndonesianSubtitle: true,
          likeCount: 0,
          lifecycleState: overrides.lifecycleState,
          objectStorageKey: overrides.objectStorageKey ?? null,
          accessTierOverride: overrides.accessTierOverride ?? 'free',
        },
      });
      return id;
    }

    afterAll(async () => {
      await prisma.video.deleteMany({
        where: { seriesId: playbackSeriesId },
      });
    });

    it('returns 401 for an unauthenticated request', async () => {
      const id = await createFixture({
        lifecycleState: 'published',
        objectStorageKey: 'r2/unauth/source.mp4',
      });

      const response = await request(app.getHttpServer())
        .get(`/videos/${id}/playback`)
        .expect(HttpStatus.UNAUTHORIZED);

      expect((response.body as ErrorResponseBody).code).toBe(
        'INVALID_ACCESS_TOKEN',
      );
      expect(mockStorageService.createPresignedGetUrl).not.toHaveBeenCalled();
    });

    it('returns 404 for a nonexistent id', async () => {
      const response = await request(app.getHttpServer())
        .get('/videos/does-not-exist/playback')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.NOT_FOUND);

      expect((response.body as ErrorResponseBody).code).toBe('VIDEO_NOT_FOUND');
    });

    it.each([
      ['draft', 'draft'],
      ['ready (not yet published)', 'ready'],
      ['unpublished', 'unpublished'],
      ['failed', 'failed'],
    ])(
      'denies a %s row exactly like /stream does (404 VIDEO_NOT_FOUND, not playable)',
      async (_label, lifecycleState) => {
        const id = await createFixture({
          lifecycleState,
          objectStorageKey: 'r2/not-published/source.mp4',
        });

        const response = await request(app.getHttpServer())
          .get(`/videos/${id}/playback`)
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(HttpStatus.NOT_FOUND);

        expect((response.body as ErrorResponseBody).code).toBe(
          'VIDEO_NOT_FOUND',
        );
        expect(mockStorageService.createPresignedGetUrl).not.toHaveBeenCalled();
      },
    );

    it('published R2-backed media: 200, a presigned playbackUrl, requiresAuthHeader false', async () => {
      const id = await createFixture({
        lifecycleState: 'published',
        objectStorageKey: 'r2/free-episode/source.mp4',
      });
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
      mockStorageService.createPresignedGetUrl.mockResolvedValueOnce({
        url: 'https://signed.example.test/r2/free-episode/source.mp4?X-Amz-Signature=deadbeef',
        key: 'r2/free-episode/source.mp4',
        expiresAt,
      });

      const response = await request(app.getHttpServer())
        .get(`/videos/${id}/playback`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK);

      const playback = response.body as VideoPlaybackResponseDto;
      expect(playback).toEqual({
        playbackUrl:
          'https://signed.example.test/r2/free-episode/source.mp4?X-Amz-Signature=deadbeef',
        expiresAt: expiresAt.toISOString(),
        requiresAuthHeader: false,
      });
      // The signer is called with EXACTLY the key from the media row — no
      // request-supplied value (the request only ever carried the video's
      // `id`) can influence which key gets signed.
      expect(mockStorageService.createPresignedGetUrl).toHaveBeenCalledWith(
        'r2/free-episode/source.mp4',
        expect.objectContaining({ expiresInSeconds: 15 * 60 }),
      );
    });

    it('published LOCAL media: 200, the existing /stream URL, requiresAuthHeader true', async () => {
      const id = await createFixture({
        lifecycleState: 'published',
        storageKey: 'series/local-episode.mp4',
        objectStorageKey: null,
      });
      const before = Date.now();

      const response = await request(app.getHttpServer())
        .get(`/videos/${id}/playback`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK);
      const after = Date.now();

      const playback = response.body as VideoPlaybackResponseDto;
      expect(playback.playbackUrl).toBe(
        `${process.env.PUBLIC_BASE_URL}/videos/${id}/stream`,
      );
      expect(playback.requiresAuthHeader).toBe(true);
      // Tightly windowed (not just "is a valid date"): pins the local
      // branch to the dedicated 15-minute `PLAYBACK_URL_EXPIRY_SECONDS`
      // constant, not the 1-hour `DEFAULT_GET_URL_EXPIRY_SECONDS` — the
      // exact literal is unit-tested precisely (via a mocked `Date.now`)
      // in `videos.service.spec.ts`; this e2e round trip only allows for
      // real wall-clock elapsed time between `before`/`after` above.
      const expiresAtMs = new Date(playback.expiresAt).getTime();
      expect(expiresAtMs).toBeGreaterThanOrEqual(before + 15 * 60 * 1000);
      expect(expiresAtMs).toBeLessThanOrEqual(after + 15 * 60 * 1000);
      expect(mockStorageService.createPresignedGetUrl).not.toHaveBeenCalled();
    });

    it('an R2 row with objectStorageKey empty and no local storageKey either fails closed — no signing attempted', async () => {
      const id = await createFixture({
        lifecycleState: 'published',
        storageKey: '',
        objectStorageKey: '',
      });

      const response = await request(app.getHttpServer())
        .get(`/videos/${id}/playback`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.CONFLICT);

      expect((response.body as ErrorResponseBody).code).toBe(
        'MEDIA_PLAYBACK_SOURCE_UNAVAILABLE',
      );
      expect(mockStorageService.createPresignedGetUrl).not.toHaveBeenCalled();
    });

    /**
     * LOW-but-cheap negative test (independent review, 2026-08-08): the
     * "signer is called with exactly the row's key" tests above only prove
     * this POSITIVELY (no attempt was ever made to override it). This test
     * actively tries plausible override vectors — a query string, a body
     * (unusual on a GET, but nothing stops a client from sending one), and
     * a custom header — and proves none of them reach the signer: the
     * route binds only `@Param('id')`/`@CurrentUser()`, so nothing in the
     * request other than `id` is ever read.
     */
    it('a request-supplied query param, body field, or custom header cannot influence which key gets signed (object-key trust boundary)', async () => {
      const id = await createFixture({
        lifecycleState: 'published',
        objectStorageKey: 'r2/trust-boundary/source.mp4',
      });
      mockStorageService.createPresignedGetUrl.mockResolvedValueOnce({
        url: 'https://signed.example.test/trust-boundary',
        key: 'r2/trust-boundary/source.mp4',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });
      const attackerKey = 'evil/attacker-supplied-key.mp4';

      const response = await request(app.getHttpServer())
        .get(`/videos/${id}/playback`)
        .query({ objectStorageKey: attackerKey, key: attackerKey })
        .set('Authorization', `Bearer ${accessToken}`)
        .set('x-object-key', attackerKey)
        .set('x-storage-key', attackerKey)
        .send({ objectStorageKey: attackerKey, key: attackerKey })
        .expect(HttpStatus.OK);

      expect(
        (response.body as VideoPlaybackResponseDto).requiresAuthHeader,
      ).toBe(false);
      expect(mockStorageService.createPresignedGetUrl).toHaveBeenCalledTimes(1);
      expect(mockStorageService.createPresignedGetUrl).toHaveBeenCalledWith(
        'r2/trust-boundary/source.mp4',
        expect.any(Object),
      );
      expect(mockStorageService.createPresignedGetUrl).not.toHaveBeenCalledWith(
        attackerKey,
        expect.anything(),
      );
    });

    /**
     * ⚠️ The paywall-bypass test — this is the highest-risk property of the
     * whole slice (DECISIONS.md "load-bearing discovery" paragraph): a
     * non-entitled caller must NOT be able to obtain a playable URL (of
     * either storage kind) for a premium episode just by calling
     * `/playback` instead of `/stream`.
     */
    describe('premium entitlement gate (the paywall-bypass risk)', () => {
      it('denies an R2-backed premium episode for a non-entitled caller — 403 ENTITLEMENT_REQUIRED, no signing attempted', async () => {
        const id = await createFixture({
          lifecycleState: 'published',
          episodeNumber: 6,
          objectStorageKey: 'r2/premium-episode/source.mp4',
          accessTierOverride: 'premium',
        });

        const response = await request(app.getHttpServer())
          .get(`/videos/${id}/playback`)
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(HttpStatus.FORBIDDEN);

        expect((response.body as ErrorResponseBody).code).toBe(
          'ENTITLEMENT_REQUIRED',
        );
        expect(mockStorageService.createPresignedGetUrl).not.toHaveBeenCalled();
      });

      it('allows an R2-backed premium episode once the caller holds an active entitlement', async () => {
        const id = await createFixture({
          lifecycleState: 'published',
          episodeNumber: 6,
          objectStorageKey: 'r2/premium-episode-entitled/source.mp4',
          accessTierOverride: 'premium',
        });
        await prisma.entitlement.create({
          data: { userId, tier: 'premium', source: 'dev-grant' },
        });
        mockStorageService.createPresignedGetUrl.mockResolvedValueOnce({
          url: 'https://signed.example.test/premium-entitled',
          key: 'r2/premium-episode-entitled/source.mp4',
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        });

        const response = await request(app.getHttpServer())
          .get(`/videos/${id}/playback`)
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(HttpStatus.OK);

        expect(
          (response.body as VideoPlaybackResponseDto).requiresAuthHeader,
        ).toBe(false);
        expect(mockStorageService.createPresignedGetUrl).toHaveBeenCalledWith(
          'r2/premium-episode-entitled/source.mp4',
          expect.any(Object),
        );

        await prisma.entitlement.deleteMany({ where: { userId } });
      });

      it('the existing local premium episode (video-104-06) is still denied without an entitlement and allowed with one — unchanged /stream behavior', async () => {
        const denied = await request(app.getHttpServer())
          .get(`/videos/${premiumEpisodeId}/playback`)
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(HttpStatus.FORBIDDEN);
        expect((denied.body as ErrorResponseBody).code).toBe(
          'ENTITLEMENT_REQUIRED',
        );

        await prisma.entitlement.create({
          data: { userId, tier: 'premium', source: 'dev-grant' },
        });

        const allowed = await request(app.getHttpServer())
          .get(`/videos/${premiumEpisodeId}/playback`)
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(HttpStatus.OK);
        const playback = allowed.body as VideoPlaybackResponseDto;
        expect(playback.requiresAuthHeader).toBe(true);
        expect(playback.playbackUrl).toBe(
          `${process.env.PUBLIC_BASE_URL}/videos/${premiumEpisodeId}/stream`,
        );

        await prisma.entitlement.deleteMany({ where: { userId } });
      });

      /**
       * Independent review (2026-08-08): every premium-gate fixture above
       * sets `episodeNumber: 6` AND `accessTierOverride: 'premium'`
       * together, so the two signals never disagree — a regression that
       * silently swapped `resolveEpisodePremium` for the raw
       * `isEpisodePremium(episodeNumber, FREE_EPISODE_LIMIT)` rule would
       * pass every test above unnoticed. These two tests mirror the
       * `/stream` "override" describe block's existing forced-premium/
       * forced-free coverage, but against `/playback`, so drift between
       * the two routes' entitlement resolution is caught here too — this
       * is exactly the drift the shared `enforceEntitlementGate` helper
       * exists to prevent, so it gets its own pin on the new route.
       */
      it('override "premium" on an otherwise-FREE episode still denies a non-entitled caller via /playback (accessTierOverride, not raw episodeNumber, decides)', async () => {
        const id = await createFixture({
          lifecycleState: 'published',
          episodeNumber: 1, // otherwise free per the raw episodeNumber rule
          objectStorageKey: 'r2/override-forced-premium/source.mp4',
          accessTierOverride: 'premium',
        });

        const response = await request(app.getHttpServer())
          .get(`/videos/${id}/playback`)
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(HttpStatus.FORBIDDEN);

        expect((response.body as ErrorResponseBody).code).toBe(
          'ENTITLEMENT_REQUIRED',
        );
        expect(mockStorageService.createPresignedGetUrl).not.toHaveBeenCalled();
      });

      it('override "free" on an otherwise-PREMIUM episode is playable via /playback without an entitlement (accessTierOverride, not raw episodeNumber, decides)', async () => {
        const id = await createFixture({
          lifecycleState: 'published',
          episodeNumber: 6, // otherwise premium per the raw episodeNumber rule
          objectStorageKey: 'r2/override-forced-free/source.mp4',
          accessTierOverride: 'free',
        });
        mockStorageService.createPresignedGetUrl.mockResolvedValueOnce({
          url: 'https://signed.example.test/override-forced-free',
          key: 'r2/override-forced-free/source.mp4',
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        });

        const response = await request(app.getHttpServer())
          .get(`/videos/${id}/playback`)
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(HttpStatus.OK);

        expect(
          (response.body as VideoPlaybackResponseDto).requiresAuthHeader,
        ).toBe(false);
        expect(mockStorageService.createPresignedGetUrl).toHaveBeenCalledWith(
          'r2/override-forced-free/source.mp4',
          expect.any(Object),
        );
      });
    });

    it('the response body contains exactly the three contracted keys — no bucket, endpoint host, account id, or credential/configuration field ever leaks', async () => {
      const id = await createFixture({
        lifecycleState: 'published',
        objectStorageKey: 'r2/shape-check/source.mp4',
      });
      mockStorageService.createPresignedGetUrl.mockResolvedValueOnce({
        url: 'https://signed.example.test/shape-check?X-Amz-Signature=deadbeef',
        key: 'r2/shape-check/source.mp4',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });

      const response = await request(app.getHttpServer())
        .get(`/videos/${id}/playback`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK);

      expect(Object.keys(response.body as object).sort()).toEqual(
        ['expiresAt', 'playbackUrl', 'requiresAuthHeader'].sort(),
      );
    });
  });

  /**
   * Slice 11Q — Private HLS Delivery Gateway (control-workspace
   * DECISIONS.md "2026-08-10 — Slice 11Q APPROVED..." entry). Same route
   * (`GET /videos/:id/playback`), same `app`/auth/entitlement machinery as
   * the 11M describe block above — these fixtures are created directly via
   * `prisma.video.create` with `processingState`/`hlsMasterKey`/
   * `hlsRenditions` set, never through the real (still-disabled)
   * TRANSCODE_ENABLED pipeline.
   */
  describe('GET /videos/:id/playback — HLS gateway (Slice 11Q)', () => {
    const hlsSeriesId = `${emailPrefix}-11q-hls-playback`;
    let hlsFixtureCounter = 0;

    async function createHlsFixture(overrides: {
      episodeNumber?: number;
      accessTierOverride?: string | null;
      processingState?: string | null;
      hlsMasterKey?: string | null;
      hlsRenditions?: unknown;
    }): Promise<{ id: string; prefix: string }> {
      hlsFixtureCounter += 1;
      const id = `${hlsSeriesId}-${hlsFixtureCounter}`;
      const prefix = `admin-media/${id}/hls/v1-a1-11111111-1111-1111-1111-11111111111${hlsFixtureCounter}/`;
      await prisma.video.create({
        data: {
          id,
          seriesId: hlsSeriesId,
          title: `HLS playback fixture ${id}`,
          episodeNumber: overrides.episodeNumber ?? 1,
          channelName: 'E2E Channel',
          caption: 'HLS playback fixture caption',
          category: 'drama',
          storageKey: '',
          objectStorageKey: 'r2/hls-fixture-fallback/source.mp4',
          sourceLanguage: 'zh',
          hasEmbeddedIndonesianSubtitle: true,
          likeCount: 0,
          lifecycleState: 'published',
          accessTierOverride: overrides.accessTierOverride ?? 'free',
          processingState:
            overrides.processingState === undefined
              ? 'ready'
              : overrides.processingState,
          hlsMasterKey:
            overrides.hlsMasterKey === undefined
              ? `${prefix}master.m3u8`
              : overrides.hlsMasterKey,
          hlsRenditions:
            overrides.hlsRenditions === undefined
              ? [
                  { name: '360p', width: 360, height: 640, bandwidth: 900_000 },
                  {
                    name: '540p',
                    width: 540,
                    height: 960,
                    bandwidth: 1_800_000,
                  },
                ]
              : (overrides.hlsRenditions as never),
        },
      });
      return { id, prefix };
    }

    afterAll(async () => {
      await prisma.video.deleteMany({ where: { seriesId: hlsSeriesId } });
    });

    it('[TEST 1/9/11] a cleanly-qualifying row returns {type:"hls", masterUrl, renditions, expiresAt} — never the legacy 3-key shape', async () => {
      const { id } = await createHlsFixture({});

      const response = await request(app.getHttpServer())
        .get(`/videos/${id}/playback`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK);

      const body = response.body as HlsPlaybackResponseDto;
      expect(Object.keys(body).sort()).toEqual(
        ['expiresAt', 'masterUrl', 'renditions', 'type'].sort(),
      );
      expect(body.type).toBe('hls');
      // Structural shape: <base>/t/<payload>.<sig>/master.m3u8 — the token
      // itself (<payload>.<sig>) is asserted as a genuine base64url pair,
      // not merely "some non-empty string", so a regression that emitted a
      // malformed/empty token would fail this.
      expect(body.masterUrl).toMatch(
        /^https:\/\/hls-gateway\.e2e-test\.internal\/t\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\/master\.m3u8$/,
      );
      expect(mockStorageService.createPresignedGetUrl).not.toHaveBeenCalled();
    });

    it('[TEST 13] returns ONLY the actually-produced renditions (360p/540p fixture never yields a 720p or 1080p entry)', async () => {
      const { id } = await createHlsFixture({});

      const response = await request(app.getHttpServer())
        .get(`/videos/${id}/playback`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK);

      const body = response.body as HlsPlaybackResponseDto;
      expect(body.renditions.map((r) => r.quality).sort()).toEqual([
        '360p',
        '540p',
      ]);
      for (const rendition of body.renditions) {
        expect(Object.keys(rendition).sort()).toEqual(
          ['height', 'quality', 'url', 'width'].sort(),
        );
        expect(rendition.url).toContain(`/${rendition.quality}/index.m3u8`);
      }
    });

    it('one token authorizes both the master playlist and every rendition (same token embedded in every url)', async () => {
      const { id } = await createHlsFixture({});

      const response = await request(app.getHttpServer())
        .get(`/videos/${id}/playback`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK);

      const body = response.body as HlsPlaybackResponseDto;
      const masterToken = body.masterUrl.split('/t/')[1].split('/')[0];
      for (const rendition of body.renditions) {
        const renditionToken = rendition.url.split('/t/')[1].split('/')[0];
        expect(renditionToken).toBe(masterToken);
      }
    });

    it('[TEST 12] a row with processingState "running" (not yet ready) falls through to the existing R2/local playback response, never an HLS shape', async () => {
      const { id } = await createHlsFixture({ processingState: 'running' });
      mockStorageService.createPresignedGetUrl.mockResolvedValueOnce({
        url: 'https://signed.example.test/hls-fixture-fallback',
        key: 'r2/hls-fixture-fallback/source.mp4',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });

      const response = await request(app.getHttpServer())
        .get(`/videos/${id}/playback`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK);

      expect('type' in (response.body as object)).toBe(false);
      expect(Object.keys(response.body as object).sort()).toEqual(
        ['expiresAt', 'playbackUrl', 'requiresAuthHeader'].sort(),
      );
    });

    it('[TEST 10] the premium entitlement gate blocks a non-entitled caller with 403 BEFORE any HLS token is minted (mintHlsToken spy proves zero calls)', async () => {
      const mintSpy = jest.spyOn(hlsPlaybackTokenUtil, 'mintHlsToken');
      const { id } = await createHlsFixture({
        episodeNumber: 6,
        accessTierOverride: 'premium',
      });

      const response = await request(app.getHttpServer())
        .get(`/videos/${id}/playback`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.FORBIDDEN);

      expect((response.body as ErrorResponseBody).code).toBe(
        'ENTITLEMENT_REQUIRED',
      );
      expect(mintSpy).not.toHaveBeenCalled();
      mintSpy.mockRestore();
    });

    it('an entitled caller CAN reach the HLS branch for a premium HLS-ready episode', async () => {
      const { id } = await createHlsFixture({
        episodeNumber: 6,
        accessTierOverride: 'premium',
      });
      await prisma.entitlement.create({
        data: { userId, tier: 'premium', source: 'dev-grant' },
      });

      const response = await request(app.getHttpServer())
        .get(`/videos/${id}/playback`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK);

      expect((response.body as HlsPlaybackResponseDto).type).toBe('hls');

      await prisma.entitlement.deleteMany({ where: { userId } });
    });

    it('[TEST 14] the HLS_TOKEN_SECRET value never appears anywhere in the response body', async () => {
      const { id } = await createHlsFixture({});

      const response = await request(app.getHttpServer())
        .get(`/videos/${id}/playback`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK);

      expect(JSON.stringify(response.body)).not.toContain(
        process.env.HLS_TOKEN_SECRET,
      );
    });

    it('[TEST 18] mints without ever making a network call — masterUrl/rendition urls only ever combine the configured HLS_GATEWAY_BASE_URL with locally-computed strings (no fetch/StorageService call for the HLS branch)', async () => {
      const { id } = await createHlsFixture({});

      const response = await request(app.getHttpServer())
        .get(`/videos/${id}/playback`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK);

      const body = response.body as HlsPlaybackResponseDto;
      expect(body.masterUrl.startsWith(process.env.HLS_GATEWAY_BASE_URL!)).toBe(
        true,
      );
      expect(mockStorageService.createPresignedGetUrl).not.toHaveBeenCalled();
    });

    it('returns 404 VIDEO_NOT_FOUND for a nonexistent id, exactly like the legacy branch (no HLS-specific behavior change to that guard)', async () => {
      const response = await request(app.getHttpServer())
        .get('/videos/does-not-exist-hls/playback')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.NOT_FOUND);

      expect((response.body as ErrorResponseBody).code).toBe('VIDEO_NOT_FOUND');
    });
  });
});
