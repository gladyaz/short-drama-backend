import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { PLAYBACK_URL_EXPIRY_SECONDS } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import * as hlsPlaybackTokenUtil from '../transcode/hls/hls-playback-token.util';
import { VideosService } from './videos.service';
import { VIDEOS } from './videos.data';

// Only `existsSync`/`statSync` are mocked, and they fall back to the real
// implementation by default. Prisma's query engine needs the real `fs`
// module (including these two functions) at both connect- and query-time to
// locate its native binary, so a blanket `jest.mock('fs')` — or mocks with no
// default implementation — would break every Prisma call in this suite.
// Tests below override the mock's return value only for the duration of a
// single `it`, which is safe because Prisma's engine has already resolved
// its binary path during `onModuleInit` in `beforeEach`.
const actualFs: typeof fs = jest.requireActual('fs');
jest.mock('fs', () => {
  const realFs: typeof fs = jest.requireActual('fs');
  return {
    ...realFs,
    existsSync: jest.fn(),
    statSync: jest.fn(),
  };
});

const TEST_APP_CONFIG = {
  port: 3000,
  publicBaseUrl: 'http://localhost:3000',
  storageRoot: '/company/storage',
  corsOrigins: ['http://localhost:8081'],
};

/**
 * Slice 11Q: `VideosService`'s constructor now ALSO reads
 * `configService.get('hlsGateway', ...)`, so the shared `ConfigService`
 * mock below must route by key rather than returning the same object for
 * every call (as it did before this slice, when `VideosService` only ever
 * read the `'app'` key). Every EXISTING test in this file is unaffected —
 * none of them ever reach the HLS branch (`tryBuildHlsPlaybackResponse`
 * returns `null` immediately for a row whose `processingState !== 'ready'`,
 * which is every fixture row this file creates outside the dedicated HLS
 * describe block below) — this default value exists only so THOSE new
 * tests have a working gateway config without a per-test override.
 */
const TEST_HLS_GATEWAY_CONFIG = {
  baseUrl: 'https://hls-gateway.example.test',
  tokenSecret: 'videos-service-spec-hls-token-secret',
  ttlSeconds: 3600,
};

/**
 * Integration-style spec (Phase 8, work unit 8-B4) confirming `VideosService`
 * reads from the real `Video` table via `PrismaService`, following the same
 * pattern as the 8-B2/8-B3 model specs: seed dedicated test rows in
 * `beforeEach`, assert against real query results, and remove exactly what
 * was created in `afterEach` so the spec leaves no residue behind (it does
 * not touch or depend on the app's seeded catalog data).
 */
describe('VideosService', () => {
  let service: VideosService;
  let prisma: PrismaService;
  let storageService: { createPresignedGetUrl: jest.Mock };
  const mockedFs = fs as jest.Mocked<typeof fs>;

  const testVideoIdPrefix = 'videos-service-spec';
  const testVideos = [
    {
      id: `${testVideoIdPrefix}-01`,
      seriesId: `${testVideoIdPrefix}-series`,
      title: 'Spec Video One',
      episodeNumber: 1,
      channelName: 'Spec Channel',
      caption: 'Spec caption one',
      category: 'drama',
      storageKey: 'Spec Series/1_subtitled.mp4',
      sourceLanguage: 'zh',
      hasEmbeddedIndonesianSubtitle: true,
      likeCount: 10,
      width: 720,
      height: 1280,
    },
    {
      id: `${testVideoIdPrefix}-02`,
      seriesId: `${testVideoIdPrefix}-series`,
      title: 'Spec Video Two',
      episodeNumber: 2,
      channelName: 'Spec Channel',
      caption: 'Spec caption two',
      category: 'drama',
      storageKey: 'Spec Series/2_subtitled.mp4',
      sourceLanguage: 'zh',
      hasEmbeddedIndonesianSubtitle: true,
      likeCount: 8,
      width: 720,
      height: 1280,
    },
    {
      id: `${testVideoIdPrefix}-03`,
      seriesId: `${testVideoIdPrefix}-series`,
      title: 'Spec Video Three',
      episodeNumber: 3,
      channelName: 'Spec Channel',
      caption: 'Spec caption three',
      category: 'drama',
      storageKey: 'Spec Series/3_subtitled.mp4',
      sourceLanguage: 'zh',
      hasEmbeddedIndonesianSubtitle: true,
      likeCount: 6,
      width: 720,
      height: 1280,
    },
  ];

  beforeEach(async () => {
    jest.clearAllMocks();
    // Restore the pass-through default (see comment above `jest.mock('fs')`)
    // in case a prior test overrode it with `mockReturnValue`.
    mockedFs.existsSync.mockImplementation(actualFs.existsSync);
    mockedFs.statSync.mockImplementation(actualFs.statSync);

    storageService = { createPresignedGetUrl: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        PrismaService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'hlsGateway' ? TEST_HLS_GATEWAY_CONFIG : TEST_APP_CONFIG,
            ),
          },
        },
        { provide: StorageService, useValue: storageService },
      ],
    }).compile();

    service = module.get<VideosService>(VideosService);
    prisma = module.get<PrismaService>(PrismaService);
    await prisma.onModuleInit();

    for (const record of testVideos) {
      await prisma.video.create({ data: record });
    }
  });

  afterEach(async () => {
    await prisma.video.deleteMany({
      where: { seriesId: `${testVideoIdPrefix}-series` },
    });
    await prisma.onModuleDestroy();
  });

  describe('findAll', () => {
    it('returns at least three videos with generated playbackUrl and no absolute storage path', async () => {
      const videos = await service.findAll();

      expect(videos.length).toBeGreaterThanOrEqual(3);

      const serialized = JSON.stringify(videos);
      expect(serialized).not.toContain(TEST_APP_CONFIG.storageRoot);

      for (const video of videos) {
        expect(video.playbackUrl).toBe(
          `http://localhost:3000/videos/${video.id}/stream`,
        );
        expect(video.storageKey.startsWith('/')).toBe(false);
      }

      const specVideo = videos.find((v) => v.id === testVideos[0].id);
      expect(specVideo?.hasEmbeddedIndonesianSubtitle).toBe(true);
    });

    it('returns videos ordered by the explicit sortOrder column, not insertion or id order', async () => {
      // Regression test for work unit 8-B4 fix cycle 1: `findAll()` must not
      // rely on incidental SQLite primary-key ordering. Assign sortOrder
      // values that are the reverse of both creation order (spec-01 created
      // first, in beforeEach) and alphabetical id order, so the assertion
      // below can only pass if the query genuinely orders by `sortOrder`.
      await prisma.video.update({
        where: { id: testVideos[0].id },
        data: { sortOrder: 1002 },
      });
      await prisma.video.update({
        where: { id: testVideos[1].id },
        data: { sortOrder: 1001 },
      });
      await prisma.video.update({
        where: { id: testVideos[2].id },
        data: { sortOrder: 1000 },
      });

      const videos = await service.findAll();
      const specVideoIds = videos
        .map((video) => video.id)
        .filter((id) => id.startsWith(testVideoIdPrefix));

      expect(specVideoIds).toEqual([
        testVideos[2].id,
        testVideos[1].id,
        testVideos[0].id,
      ]);
    });

    it('excludes a video whose lifecycleState is not "published" (Phase 11, work unit 11B-3)', async () => {
      await prisma.video.update({
        where: { id: testVideos[0].id },
        data: { lifecycleState: 'draft' },
      });

      const videos = await service.findAll();
      const specVideoIds = videos.map((video) => video.id);

      expect(specVideoIds).not.toContain(testVideos[0].id);
      expect(specVideoIds).toContain(testVideos[1].id);
    });

    describe('non-playable published rows (Phase 11, work unit 11G-1)', () => {
      it('excludes a published row with an empty storageKey and no objectStorageKey', async () => {
        await prisma.video.update({
          where: { id: testVideos[0].id },
          data: { storageKey: '', objectStorageKey: null },
        });

        const videos = await service.findAll();
        const specVideoIds = videos.map((video) => video.id);

        expect(specVideoIds).not.toContain(testVideos[0].id);
        expect(specVideoIds).toContain(testVideos[1].id);
      });

      it('keeps a published row with a non-empty storageKey (the existing/default shape)', async () => {
        const videos = await service.findAll();
        const specVideoIds = videos.map((video) => video.id);

        // testVideos[0] already has a non-empty storageKey and no
        // objectStorageKey from the beforeEach fixture — this is the
        // baseline "still works" case for the OR filter.
        expect(specVideoIds).toContain(testVideos[0].id);
      });

      it('keeps a published row with an empty storageKey but a non-null objectStorageKey', async () => {
        await prisma.video.update({
          where: { id: testVideos[0].id },
          data: { storageKey: '', objectStorageKey: 'r2/spec-video-one.mp4' },
        });

        const videos = await service.findAll();
        const specVideoIds = videos.map((video) => video.id);

        expect(specVideoIds).toContain(testVideos[0].id);
      });

      it('does not change feed length behavior for the real 40 seed rows (all still present)', async () => {
        const videos = await service.findAll();
        const returnedIds = new Set(videos.map((video) => video.id));
        const seedIds = VIDEOS.map((video) => video.id);

        expect(seedIds).toHaveLength(40);
        for (const seedId of seedIds) {
          expect(returnedIds.has(seedId)).toBe(true);
        }
      });
    });
  });

  describe('findById', () => {
    it('returns the matching video for a known id', async () => {
      const found = await service.findById(testVideos[0].id);
      expect(found.id).toBe(testVideos[0].id);
      expect(found.title).toBe(testVideos[0].title);
      expect(found.storageKey).toBe(testVideos[0].storageKey);
    });

    it('throws VIDEO_NOT_FOUND for an unknown id', async () => {
      let caught: unknown;
      try {
        await service.findById('does-not-exist');
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AppException);
      expect((caught as AppException).code).toBe(AppErrorCode.VIDEO_NOT_FOUND);
    });

    it('throws VIDEO_NOT_FOUND for a video that exists but is not "published" (Phase 11, work unit 11B-3)', async () => {
      await prisma.video.update({
        where: { id: testVideos[0].id },
        data: { lifecycleState: 'draft' },
      });

      let caught: unknown;
      try {
        await service.findById(testVideos[0].id);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AppException);
      expect((caught as AppException).code).toBe(AppErrorCode.VIDEO_NOT_FOUND);
    });
  });

  describe('getStreamGuardInfo (work unit 11E-3)', () => {
    it('returns episodeNumber and a null accessTierOverride for a fixture row created without one', async () => {
      const info = await service.getStreamGuardInfo(testVideos[0].id);
      expect(info).toEqual({
        episodeNumber: testVideos[0].episodeNumber,
        accessTierOverride: null,
      });
    });

    it('returns the raw accessTierOverride value when one is set', async () => {
      await prisma.video.update({
        where: { id: testVideos[0].id },
        data: { accessTierOverride: 'premium' },
      });

      const info = await service.getStreamGuardInfo(testVideos[0].id);
      expect(info.accessTierOverride).toBe('premium');
    });

    it('throws VIDEO_NOT_FOUND for an unknown id', async () => {
      await expect(
        service.getStreamGuardInfo('does-not-exist'),
      ).rejects.toMatchObject({ code: AppErrorCode.VIDEO_NOT_FOUND });
    });

    it('throws VIDEO_NOT_FOUND for a video that exists but is not "published"', async () => {
      await prisma.video.update({
        where: { id: testVideos[0].id },
        data: { lifecycleState: 'draft' },
      });

      await expect(
        service.getStreamGuardInfo(testVideos[0].id),
      ).rejects.toMatchObject({ code: AppErrorCode.VIDEO_NOT_FOUND });
    });
  });

  describe('getPlaybackUrl (Phase 11, work unit 11M-B3/B4)', () => {
    it('returns the existing stream URL with requiresAuthHeader: true for a local-backed row', async () => {
      // testVideos[0] has a non-empty storageKey and no objectStorageKey
      // from the beforeEach fixture (the baseline local-media shape).
      const result = await service.getPlaybackUrl(testVideos[0].id);

      expect(result.playbackUrl).toBe(
        `http://localhost:3000/videos/${testVideos[0].id}/stream`,
      );
      expect(result.requiresAuthHeader).toBe(true);
      expect(storageService.createPresignedGetUrl).not.toHaveBeenCalled();
    });

    /**
     * Independent review (2026-08-08): the previous version of this
     * assertion only lower-bounded the local branch's `expiresAt`
     * (`toBeGreaterThanOrEqual`), which a mutation that swapped in the
     * 1-hour `DEFAULT_GET_URL_EXPIRY_SECONDS` would still satisfy — the
     * bug would never be caught. `Date.now` is mocked to a fixed instant
     * for the duration of the call so the EXACT expected ISO string can be
     * computed and compared, pinning the local branch to precisely
     * `PLAYBACK_URL_EXPIRY_SECONDS`, matching the rigour the R2 branch's
     * assertions already had (they compare against the literal signer
     * mock's `expiresAt`).
     */
    it('pins the local branch expiresAt to EXACTLY PLAYBACK_URL_EXPIRY_SECONDS from now — not merely a lower bound', async () => {
      const fixedNowMs = Date.now();
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(fixedNowMs);

      try {
        const result = await service.getPlaybackUrl(testVideos[0].id);

        expect(result.expiresAt).toBe(
          new Date(
            fixedNowMs + PLAYBACK_URL_EXPIRY_SECONDS * 1000,
          ).toISOString(),
        );
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('returns a presigned R2 URL with requiresAuthHeader: false for an R2-backed row', async () => {
      await prisma.video.update({
        where: { id: testVideos[0].id },
        data: {
          storageKey: '',
          objectStorageKey: 'r2/spec-video-one/source.mp4',
        },
      });
      const signedExpiresAt = new Date(
        Date.now() + PLAYBACK_URL_EXPIRY_SECONDS * 1000,
      );
      storageService.createPresignedGetUrl.mockResolvedValueOnce({
        url: 'https://signed.example.test/r2/spec-video-one/source.mp4?X-Amz-Signature=abc',
        key: 'r2/spec-video-one/source.mp4',
        expiresAt: signedExpiresAt,
      });

      const result = await service.getPlaybackUrl(testVideos[0].id);

      expect(result).toEqual({
        playbackUrl:
          'https://signed.example.test/r2/spec-video-one/source.mp4?X-Amz-Signature=abc',
        expiresAt: signedExpiresAt.toISOString(),
        requiresAuthHeader: false,
      });
    });

    it('calls the signer with EXACTLY the objectStorageKey stored on the row and the dedicated 15-minute expiry, never a request-supplied value', async () => {
      await prisma.video.update({
        where: { id: testVideos[0].id },
        data: {
          storageKey: '',
          objectStorageKey: 'r2/exact-key-check/source.mp4',
        },
      });
      storageService.createPresignedGetUrl.mockResolvedValueOnce({
        url: 'https://signed.example.test/exact-key-check',
        key: 'r2/exact-key-check/source.mp4',
        expiresAt: new Date(),
      });

      await service.getPlaybackUrl(testVideos[0].id);

      expect(storageService.createPresignedGetUrl).toHaveBeenCalledTimes(1);
      expect(storageService.createPresignedGetUrl).toHaveBeenCalledWith(
        'r2/exact-key-check/source.mp4',
        { expiresInSeconds: PLAYBACK_URL_EXPIRY_SECONDS },
      );
    });

    it('prefers R2 over local when BOTH storageKey and objectStorageKey are set (work unit 11M-B1)', async () => {
      // testVideos[0]'s beforeEach fixture already carries a non-empty
      // storageKey; add an objectStorageKey alongside it without clearing
      // storageKey, unlike the tests above.
      await prisma.video.update({
        where: { id: testVideos[0].id },
        data: { objectStorageKey: 'r2/both-set/source.mp4' },
      });
      storageService.createPresignedGetUrl.mockResolvedValueOnce({
        url: 'https://signed.example.test/both-set',
        key: 'r2/both-set/source.mp4',
        expiresAt: new Date(),
      });

      const result = await service.getPlaybackUrl(testVideos[0].id);

      expect(result.requiresAuthHeader).toBe(false);
      expect(storageService.createPresignedGetUrl).toHaveBeenCalledWith(
        'r2/both-set/source.mp4',
        expect.any(Object),
      );
    });

    it('fails closed with MEDIA_PLAYBACK_SOURCE_UNAVAILABLE and never signs when neither storageKey nor objectStorageKey is set', async () => {
      await prisma.video.update({
        where: { id: testVideos[0].id },
        data: { storageKey: '', objectStorageKey: null },
      });

      let caught: unknown;
      try {
        await service.getPlaybackUrl(testVideos[0].id);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AppException);
      expect((caught as AppException).code).toBe(
        AppErrorCode.MEDIA_PLAYBACK_SOURCE_UNAVAILABLE,
      );
      expect(storageService.createPresignedGetUrl).not.toHaveBeenCalled();
    });

    it('throws VIDEO_NOT_FOUND for an unknown id, never attempting to sign anything', async () => {
      await expect(
        service.getPlaybackUrl('does-not-exist'),
      ).rejects.toMatchObject({ code: AppErrorCode.VIDEO_NOT_FOUND });
      expect(storageService.createPresignedGetUrl).not.toHaveBeenCalled();
    });

    it('throws VIDEO_NOT_FOUND for a video that exists but is not "published"', async () => {
      await prisma.video.update({
        where: { id: testVideos[0].id },
        data: { lifecycleState: 'draft' },
      });

      await expect(
        service.getPlaybackUrl(testVideos[0].id),
      ).rejects.toMatchObject({ code: AppErrorCode.VIDEO_NOT_FOUND });
    });

    it('returns a response with exactly the three contracted keys — no key/bucket/config leak', async () => {
      await prisma.video.update({
        where: { id: testVideos[0].id },
        data: {
          storageKey: '',
          objectStorageKey: 'r2/shape-check/source.mp4',
        },
      });
      storageService.createPresignedGetUrl.mockResolvedValueOnce({
        url: 'https://signed.example.test/shape-check',
        key: 'r2/shape-check/source.mp4',
        expiresAt: new Date(),
      });

      const result = await service.getPlaybackUrl(testVideos[0].id);

      expect(Object.keys(result).sort()).toEqual(
        ['expiresAt', 'playbackUrl', 'requiresAuthHeader'].sort(),
      );
    });
  });

  describe('getPlaybackUrl — HLS gateway branch (Slice 11Q)', () => {
    const HLS_PREFIX = `admin-media/${testVideos[0].id}/hls/v1-a1-11111111-1111-1111-1111-111111111111/`;
    const HLS_MASTER_KEY = `${HLS_PREFIX}master.m3u8`;
    const HLS_RENDITIONS = [
      { name: '360p', width: 360, height: 640, bandwidth: 900_000 },
      { name: '540p', width: 540, height: 960, bandwidth: 1_800_000 },
      { name: '720p', width: 720, height: 1280, bandwidth: 3_300_000 },
    ];

    it('[TEST 12a] a row with processingState "ready" but no hlsMasterKey falls through to the existing legacy/R2 branch unchanged', async () => {
      await prisma.video.update({
        where: { id: testVideos[0].id },
        data: { processingState: 'ready', hlsMasterKey: null },
      });

      const result = await service.getPlaybackUrl(testVideos[0].id);

      expect('type' in result).toBe(false);
      expect(result.playbackUrl).toBe(
        `http://localhost:3000/videos/${testVideos[0].id}/stream`,
      );
    });

    it.each(['queued', 'running', 'failed', null])(
      '[TEST 12b] a row with hlsMasterKey set but processingState=%s never yields an HLS URL',
      async (processingState) => {
        await prisma.video.update({
          where: { id: testVideos[0].id },
          data: { processingState, hlsMasterKey: HLS_MASTER_KEY },
        });

        const result = await service.getPlaybackUrl(testVideos[0].id);

        expect('type' in result).toBe(false);
        expect(result.playbackUrl).toBe(
          `http://localhost:3000/videos/${testVideos[0].id}/stream`,
        );
      },
    );

    it('a row that cleanly qualifies (ready + hlsMasterKey) returns the {type:"hls", masterUrl, renditions, expiresAt} shape', async () => {
      await prisma.video.update({
        where: { id: testVideos[0].id },
        data: {
          processingState: 'ready',
          hlsMasterKey: HLS_MASTER_KEY,
          hlsRenditions: HLS_RENDITIONS,
        },
      });

      const result = await service.getPlaybackUrl(testVideos[0].id);

      expect(Object.keys(result).sort()).toEqual(
        ['expiresAt', 'masterUrl', 'renditions', 'type'].sort(),
      );
      const hlsResult =
        result as import('./video.types').HlsPlaybackResponseDto;
      expect(hlsResult.type).toBe('hls');
      expect(hlsResult.masterUrl).toMatch(
        new RegExp(
          `^${TEST_HLS_GATEWAY_CONFIG.baseUrl}/t/[^/]+\\.[^/]+/master\\.m3u8$`,
        ),
      );
    });

    it('[TEST 13] returns ONLY the renditions actually produced — a 720p-max source (no 1080p entry persisted) never yields a 1080p rendition', async () => {
      await prisma.video.update({
        where: { id: testVideos[0].id },
        data: {
          processingState: 'ready',
          hlsMasterKey: HLS_MASTER_KEY,
          hlsRenditions: HLS_RENDITIONS, // 360p/540p/720p only — no 1080p
        },
      });

      const result = (await service.getPlaybackUrl(
        testVideos[0].id,
      )) as import('./video.types').HlsPlaybackResponseDto;

      expect(result.renditions).toHaveLength(3);
      expect(result.renditions.map((r) => r.quality).sort()).toEqual([
        '360p',
        '540p',
        '720p',
      ]);
      expect(result.renditions.some((r) => r.quality === '1080p')).toBe(false);
      for (const rendition of result.renditions) {
        expect(rendition.url).toMatch(
          new RegExp(
            `^${TEST_HLS_GATEWAY_CONFIG.baseUrl}/t/[^/]+\\.[^/]+/${rendition.quality}/index\\.m3u8$`,
          ),
        );
      }
    });

    it('mints via mintHlsToken with the exact derived prefix, mediaId, and configured ttl/secret — proving the token is content/version-bound to THIS row', async () => {
      const mintSpy = jest.spyOn(hlsPlaybackTokenUtil, 'mintHlsToken');

      await prisma.video.update({
        where: { id: testVideos[0].id },
        data: {
          processingState: 'ready',
          hlsMasterKey: HLS_MASTER_KEY,
          hlsRenditions: HLS_RENDITIONS,
        },
      });

      await service.getPlaybackUrl(testVideos[0].id);

      expect(mintSpy).toHaveBeenCalledWith({
        mediaId: testVideos[0].id,
        prefix: HLS_PREFIX,
        ttlSeconds: TEST_HLS_GATEWAY_CONFIG.ttlSeconds,
        secret: TEST_HLS_GATEWAY_CONFIG.tokenSecret,
      });

      mintSpy.mockRestore();
    });

    it('[TEST 10] mintHlsToken is never called for a row that does not reach the HLS branch (defense-in-depth alongside the controller-level entitlement gate, which runs BEFORE getPlaybackUrl is ever invoked)', async () => {
      const mintSpy = jest.spyOn(hlsPlaybackTokenUtil, 'mintHlsToken');

      // testVideos[0] is a plain local-backed row — never reaches the HLS
      // branch at all (processingState is null by default).
      await service.getPlaybackUrl(testVideos[0].id);

      expect(mintSpy).not.toHaveBeenCalled();
      mintSpy.mockRestore();
    });

    it("a malformed/mismatched hlsMasterKey (does not belong to this row's own id) falls back to the legacy branch instead of throwing", async () => {
      await prisma.video.update({
        where: { id: testVideos[0].id },
        data: {
          processingState: 'ready',
          hlsMasterKey:
            'admin-media/some-other-video-id/hls/v1-a1-uuid/master.m3u8',
        },
      });

      const result = await service.getPlaybackUrl(testVideos[0].id);

      expect('type' in result).toBe(false);
      expect(result.playbackUrl).toBe(
        `http://localhost:3000/videos/${testVideos[0].id}/stream`,
      );
    });

    it('fails CLOSED with HLS_GATEWAY_NOT_CONFIGURED (never mints, never assembles a URL) when a row cleanly qualifies but HLS_GATEWAY_BASE_URL/HLS_TOKEN_SECRET are not configured', async () => {
      const unconfiguredModule: TestingModule = await Test.createTestingModule({
        providers: [
          VideosService,
          PrismaService,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string) =>
                key === 'hlsGateway'
                  ? {
                      baseUrl: undefined,
                      tokenSecret: undefined,
                      ttlSeconds: 3600,
                    }
                  : TEST_APP_CONFIG,
              ),
            },
          },
          { provide: StorageService, useValue: storageService },
        ],
      }).compile();
      const unconfiguredService =
        unconfiguredModule.get<VideosService>(VideosService);
      const unconfiguredPrisma =
        unconfiguredModule.get<PrismaService>(PrismaService);
      await unconfiguredPrisma.onModuleInit();

      await prisma.video.update({
        where: { id: testVideos[0].id },
        data: {
          processingState: 'ready',
          hlsMasterKey: HLS_MASTER_KEY,
          hlsRenditions: HLS_RENDITIONS,
        },
      });

      let caught: unknown;
      try {
        await unconfiguredService.getPlaybackUrl(testVideos[0].id);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AppException);
      expect((caught as AppException).code).toBe(
        AppErrorCode.HLS_GATEWAY_NOT_CONFIGURED,
      );
      // [TEST 14] the error never leaks the (absent) secret or any config value.
      expect((caught as AppException).message).not.toContain(
        TEST_HLS_GATEWAY_CONFIG.tokenSecret,
      );

      await unconfiguredPrisma.onModuleDestroy();
    });

    it('[TEST 14] never includes the configured HLS_TOKEN_SECRET anywhere in a successful HLS response body', async () => {
      await prisma.video.update({
        where: { id: testVideos[0].id },
        data: {
          processingState: 'ready',
          hlsMasterKey: HLS_MASTER_KEY,
          hlsRenditions: HLS_RENDITIONS,
        },
      });

      const result = await service.getPlaybackUrl(testVideos[0].id);

      expect(JSON.stringify(result)).not.toContain(
        TEST_HLS_GATEWAY_CONFIG.tokenSecret,
      );
    });
  });

  describe('resolveStreamableFile', () => {
    it('returns the absolute path and size when the media file exists', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.statSync.mockReturnValue({
        isFile: () => true,
        size: 4096,
      } as unknown as fs.Stats);

      const result = await service.resolveStreamableFile(testVideos[0].id);

      expect(result.fileSize).toBe(4096);
      expect(result.absolutePath.startsWith(TEST_APP_CONFIG.storageRoot)).toBe(
        true,
      );
    });

    it('throws MEDIA_FILE_NOT_FOUND when the file is missing on disk', async () => {
      mockedFs.existsSync.mockReturnValue(false);

      let caught: unknown;
      try {
        await service.resolveStreamableFile(testVideos[0].id);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AppException);
      expect((caught as AppException).code).toBe(
        AppErrorCode.MEDIA_FILE_NOT_FOUND,
      );
    });

    it('throws VIDEO_NOT_FOUND for an unknown id without touching the filesystem', async () => {
      // Reset the call count recorded so far: Prisma's own engine resolution
      // (during `onModuleInit` in `beforeEach`) legitimately calls
      // `existsSync` for unrelated reasons before this test's "Act" phase
      // even begins, which would otherwise produce a false failure below.
      mockedFs.existsSync.mockClear();

      await expect(
        service.resolveStreamableFile('does-not-exist'),
      ).rejects.toThrow(AppException);
      expect(mockedFs.existsSync).not.toHaveBeenCalled();
    });
  });
});
