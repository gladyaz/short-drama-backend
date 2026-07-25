import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { VideosService } from './videos.service';

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        PrismaService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(TEST_APP_CONFIG) },
        },
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
