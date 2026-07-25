import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import type { AuthResponseDto } from './../src/auth/auth.types';
import {
  deriveAccessTier,
  FREE_EPISODE_LIMIT,
} from './../src/entitlements/entitlement.constants';
import { VIDEOS } from './../src/videos/videos.data';
import type { VideoResponseDto } from './../src/videos/video.types';

interface ErrorResponseBody {
  statusCode: number;
  code: string;
  message: string;
}

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let accessToken: string;
  let userId: string;

  const emailPrefix = 'videos-e2e-spec+10b3';
  const freeEpisodeId = 'video-104-01';
  const premiumEpisodeId = 'video-104-06';
  const uniqueEmail = (label: string): string =>
    `${emailPrefix}-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

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
});
