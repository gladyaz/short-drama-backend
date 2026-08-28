import { mkdir, mkdtemp, readdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import { RootConfig, TranscodeConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { StorageObjectMetadata } from '../storage/storage.types';
import { StorageService } from '../storage/storage.service';
import {
  HlsEncodeRungRequest,
  HlsEncoderClient,
  HlsProbeClient,
  HlsSourceProbe,
} from './hls/hls.types';
import { HlsPackageValidator } from './hls/hls-package-validator.service';
import { HlsTranscodeService } from './hls/hls-transcode.service';
import { MasterPlaylistService } from './hls/master-playlist.service';
import { TranscodeIntentService } from './transcode-intent.service';
import { TRANSCODE_JOB_LOG_TAG } from './transcode-job-log';
import { buildTranscodeJobId } from './transcode.constants';
import { TranscodeJobProcessor } from './transcode-job-processor.service';
import { HlsRenditionSummary } from './transcode.types';
import type {
  ThumbnailArtifact,
  ThumbnailClient,
  ThumbnailGenerateRequest,
} from '../thumbnails/thumbnail.types';

/**
 * Slice 11P — proofs 4, 5, 6, 7, 8, 9, 10, 17 (see the work-unit report's
 * "17 proofs mapped to test names" section for the exact mapping).
 *
 * `PrismaService` is the real client against the project's Postgres TEST
 * database (matching every other spec in this module). `TranscodeIntentService`
 * is REAL (constructed directly, wrapping the real `PrismaService`) so every
 * CAS write this pipeline performs is genuinely exercised, not mocked away —
 * `TranscodeIntentService`'s own dedicated spec already proves each CAS
 * primitive in isolation; this file proves the PIPELINE composes them
 * correctly end to end. `HlsTranscodeService`/`MasterPlaylistService`/
 * `HlsPackageValidator` are also REAL (Slice 11O's already-proven pure/local
 * logic), wired with a FAKE `HlsEncoderClient` (writes small real files, no
 * real ffmpeg) and a FAKE `HlsProbeClient` (returns fixed, deterministic
 * probe results — no real ffprobe). `StorageService` and `ThumbnailClient`
 * are entirely mocked — no real R2/network call, no real ffmpeg anywhere in
 * this file.
 */
describe('TranscodeJobProcessor', () => {
  let prisma: PrismaService;
  let queue: { add: jest.Mock };

  const testIdPrefix = 'transcode-job-processor-spec-11p';
  const seriesId = `${testIdPrefix}-series`;

  // A 360×640 portrait source ⇒ `computeRenditionLadder` produces EXACTLY
  // ONE rung ("360p"), keeping every fixture below small and readable.
  const SOURCE_PROBE: HlsSourceProbe = {
    width: 360,
    height: 640,
    rotation: 0,
    fps: 30,
    hasAudio: true,
    durationSeconds: 4,
    videoCodec: 'h264',
    audioCodec: 'aac',
  };
  const VARIANT_PROBE: HlsSourceProbe = {
    ...SOURCE_PROBE,
  };

  async function createFixtureVideo(
    id: string,
    overrides: Partial<{
      processingState: string | null;
      processingVersion: number;
      processingAttempts: number;
      hlsMasterKey: string | null;
      thumbnailImageKey: string | null;
    }> = {},
  ): Promise<void> {
    await prisma.video.create({
      data: {
        id,
        seriesId,
        title: 'Fixture',
        episodeNumber: 1,
        channelName: 'Fixture Channel',
        caption: 'Fixture caption',
        category: 'drama',
        storageKey: '',
        sourceLanguage: 'zh',
        hasEmbeddedIndonesianSubtitle: true,
        likeCount: 0,
        processingState: overrides.processingState ?? 'queued',
        processingVersion: overrides.processingVersion ?? 1,
        processingAttempts: overrides.processingAttempts ?? 0,
        hlsMasterKey: overrides.hlsMasterKey ?? null,
        thumbnailImageKey: overrides.thumbnailImageKey ?? null,
      },
    });
  }

  /** Writes a real, minimal, VALID CMAF/HLS rung — init.mp4/seg_00000.m4s/index.m3u8 — that `HlsPackageValidator` will accept. */
  function fakeEncoder(): HlsEncoderClient {
    return {
      encodeRung: jest.fn(async (request: HlsEncodeRungRequest) => {
        await mkdir(request.outputDir, { recursive: true });
        await writeFile(
          join(request.outputDir, 'init.mp4'),
          Buffer.alloc(200, 1),
        );
        await writeFile(
          join(request.outputDir, 'seg_00000.m4s'),
          Buffer.alloc(1000, 2),
        );
        const playlist = [
          '#EXTM3U',
          '#EXT-X-VERSION:7',
          '#EXT-X-TARGETDURATION:4',
          '#EXT-X-PLAYLIST-TYPE:VOD',
          '#EXT-X-MAP:URI="init.mp4"',
          '#EXTINF:4.000,',
          'seg_00000.m4s',
          '#EXT-X-ENDLIST',
          '',
        ].join('\n');
        await writeFile(join(request.outputDir, 'index.m3u8'), playlist);
      }),
    };
  }

  /** Source probe on `source.mp4`, VARIANT_PROBE for anything else (the one rung's `index.m3u8`). */
  function fakeProbeClient(): HlsProbeClient {
    return {
      probe: jest.fn((mediaPath: string): Promise<HlsSourceProbe> =>
        Promise.resolve(
          mediaPath.endsWith('source.mp4') ? SOURCE_PROBE : VARIANT_PROBE,
        ),
      ),
    };
  }

  /**
   * Returns the mock function as a STANDALONE binding (`generateMock`, never
   * accessed as `client.generate`), mirroring
   * `hls-transcode.service.spec.ts`'s `fakeSuccessfulEncoder` precedent — a
   * jest mock function has no meaningful `this` binding to lose, but
   * `@typescript-eslint/unbound-method` cannot tell that from a bare
   * object-method reference.
   */
  function fakeThumbnailClient(): {
    client: ThumbnailClient;
    generateMock: jest.Mock<
      Promise<ThumbnailArtifact>,
      [ThumbnailGenerateRequest]
    >;
  } {
    const generateMock = jest.fn(
      async (request: ThumbnailGenerateRequest): Promise<ThumbnailArtifact> => {
        await writeFile(request.outputPath, Buffer.alloc(100, 3));
        return { outputPath: request.outputPath, width: 480, height: 853 };
      },
    );

    return { client: { generate: generateMock }, generateMock };
  }

  interface FakeStorageService {
    downloadObjectToFile: jest.Mock<Promise<void>, [string, string]>;
    putObject: jest.Mock<Promise<void>, [string, Buffer, string?]>;
    headObject: jest.Mock<Promise<StorageObjectMetadata | null>, [string]>;
    deleteObject: jest.Mock<Promise<void>, [string]>;
  }

  function fakeStorageService(
    overrides: Partial<FakeStorageService> = {},
  ): FakeStorageService {
    return {
      downloadObjectToFile: jest.fn(
        async (_key: string, destPath: string): Promise<void> => {
          await writeFile(destPath, Buffer.alloc(50, 9));
        },
      ),
      putObject: jest
        .fn<Promise<void>, [string, Buffer, string?]>()
        .mockResolvedValue(undefined),
      headObject: jest
        .fn<Promise<StorageObjectMetadata | null>, [string]>()
        .mockImplementation((key: string) =>
          Promise.resolve({
            key,
            contentLength: 100,
            contentType: 'application/octet-stream',
          }),
        ),
      deleteObject: jest
        .fn<Promise<void>, [string]>()
        .mockResolvedValue(undefined),
      ...overrides,
    };
  }

  function buildTranscodeConfig(
    overrides: Partial<TranscodeConfig> = {},
  ): TranscodeConfig {
    return {
      enabled: true,
      redisUrl: 'redis://localhost:6379',
      maxAttempts: 3,
      stalledAfterMinutes: 30,
      cleanupGraceMinutes: 120,
      workerConcurrency: 1,
      tempDir: undefined,
      tempSweepMinAgeMinutes: 120,
      ...overrides,
    };
  }

  function buildConfigService(
    transcodeConfig: TranscodeConfig,
  ): ConfigService<RootConfig> {
    return {
      get: (key: keyof RootConfig) =>
        key === 'transcode' ? transcodeConfig : undefined,
    } as unknown as ConfigService<RootConfig>;
  }

  function buildProcessor(options: {
    storageService: ReturnType<typeof fakeStorageService>;
    probeClient?: HlsProbeClient;
    encoderClient?: HlsEncoderClient;
    thumbnailClient?: ThumbnailClient;
    transcodeConfig?: TranscodeConfig;
  }): TranscodeJobProcessor {
    const intentService = new TranscodeIntentService(prisma, queue);
    const probeClient = options.probeClient ?? fakeProbeClient();
    const transcodeService = new HlsTranscodeService(
      options.encoderClient ?? fakeEncoder(),
    );
    const masterPlaylistService = new MasterPlaylistService();
    const validator = new HlsPackageValidator(probeClient);

    return new TranscodeJobProcessor(
      prisma,
      buildConfigService(options.transcodeConfig ?? buildTranscodeConfig()),
      intentService,
      options.storageService as unknown as StorageService,
      probeClient,
      transcodeService,
      masterPlaylistService,
      validator,
      options.thumbnailClient ?? fakeThumbnailClient().client,
    );
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  beforeEach(() => {
    queue = { add: jest.fn().mockResolvedValue(undefined) };
  });

  afterEach(async () => {
    await prisma.video.deleteMany({ where: { seriesId } });
  });

  // Proof 4: stale version cannot flip live output.
  it('a payload with a stale processingVersion is superseded — the live hlsMasterKey is never touched', async () => {
    const id = `${testIdPrefix}-stale-version`;
    const liveKey = `admin-media/${id}/hls/v1-a1-old-uuid/master.m3u8`;
    await createFixtureVideo(id, {
      processingState: 'ready',
      processingVersion: 2,
      hlsMasterKey: liveKey,
    });
    const storageService = fakeStorageService();
    const processor = buildProcessor({ storageService });

    const outcome = await processor.process({
      videoId: id,
      processingVersion: 1,
    });

    expect(outcome).toEqual({
      outcome: 'superseded',
      reason: 'VERSION_MISMATCH',
    });
    const row = await prisma.video.findUniqueOrThrow({ where: { id } });
    expect(row.hlsMasterKey).toBe(liveKey);
    expect(row.processingState).toBe('ready');
    expect(storageService.putObject).not.toHaveBeenCalled();
  });

  // Proof 5: crash after partial upload leaves old live output intact.
  it('a mid-upload crash leaves the OLD live generation untouched, fails the row, and cleans up its own partial staging', async () => {
    const id = `${testIdPrefix}-mid-upload-crash`;
    const liveKey = `admin-media/${id}/hls/v1-a1-old-uuid/master.m3u8`;
    // Simulate: an already-published generation (v1) is re-requested (v2, "queued").
    await createFixtureVideo(id, {
      processingState: 'queued',
      processingVersion: 2,
      hlsMasterKey: liveKey,
    });
    const storageService = fakeStorageService();
    // master.m3u8 upload succeeds, the variant playlist upload succeeds, the
    // init.mp4 upload THROWS ("crash").
    storageService.putObject
      .mockResolvedValueOnce(undefined) // master.m3u8
      .mockResolvedValueOnce(undefined) // 360p/index.m3u8
      .mockRejectedValueOnce(new Error('simulated network interruption'));
    const processor = buildProcessor({
      storageService,
      transcodeConfig: buildTranscodeConfig({ maxAttempts: 3 }),
    });

    const outcome = await processor.process({
      videoId: id,
      processingVersion: 2,
    });

    expect(outcome).toMatchObject({
      outcome: 'failed',
      errorCode: 'UPLOAD_FAILED',
    });
    const row = await prisma.video.findUniqueOrThrow({ where: { id } });
    // Old live output is COMPLETELY intact.
    expect(row.hlsMasterKey).toBe(liveKey);
    // Cleanup deleted exactly the 2 keys that succeeded before the crash —
    // never the live key, never a broad/prefix delete.
    expect(storageService.deleteObject).toHaveBeenCalledTimes(2);
    const deletedKeys = storageService.deleteObject.mock.calls.map((c) => c[0]);
    expect(deletedKeys.every((k) => k.includes(`v2-a1-`))).toBe(true);
    expect(deletedKeys).not.toContain(liveKey);
  });

  // Proof 6: retry gets a fresh immutable prefix.
  it('a retry (requeueForRetry -> re-claim) gets a different staging prefix than the first attempt', async () => {
    const id = `${testIdPrefix}-retry-fresh-prefix`;
    await createFixtureVideo(id, {
      processingState: 'queued',
      processingVersion: 1,
    });
    const failingStorage = fakeStorageService();
    failingStorage.putObject.mockRejectedValue(new Error('boom'));
    const failingProcessor = buildProcessor({
      storageService: failingStorage,
      transcodeConfig: buildTranscodeConfig({ maxAttempts: 3 }),
    });

    const firstOutcome = await failingProcessor.process({
      videoId: id,
      processingVersion: 1,
    });
    expect(firstOutcome).toMatchObject({ outcome: 'failed', terminal: false });
    const afterFirst = await prisma.video.findUniqueOrThrow({ where: { id } });
    expect(afterFirst.processingState).toBe('queued'); // retryable, not terminal

    // Capture the first attempt's staging prefix from the failed upload call.
    const firstUploadKey = failingStorage.putObject.mock.calls[0][0];

    // Second attempt (a real BullMQ redelivery of the SAME job) succeeds.
    const succeedingStorage = fakeStorageService();
    const succeedingProcessor = buildProcessor({
      storageService: succeedingStorage,
    });

    const secondOutcome = await succeedingProcessor.process({
      videoId: id,
      processingVersion: 1,
    });
    expect(secondOutcome.outcome).toBe('promoted');
    const secondUploadKey = succeedingStorage.putObject.mock.calls[0][0];

    expect(secondUploadKey).not.toBe(firstUploadKey);
    // Different attempt number embedded in the prefix.
    expect(firstUploadKey).toContain('-a1-');
    expect(secondUploadKey).toContain('-a2-');
  });

  // Proof 7: one-rendition failure prevents promotion.
  it('an ffmpeg encode failure for one rung fails the whole job — nothing is promoted', async () => {
    const id = `${testIdPrefix}-rung-failure`;
    await createFixtureVideo(id, {
      processingState: 'queued',
      processingVersion: 1,
    });
    const storageService = fakeStorageService();
    const failingEncoder: HlsEncoderClient = {
      encodeRung: jest.fn().mockRejectedValue(new Error('ffmpeg exited 1')),
    };
    const processor = buildProcessor({
      storageService,
      encoderClient: failingEncoder,
    });

    const outcome = await processor.process({
      videoId: id,
      processingVersion: 1,
    });

    expect(outcome).toMatchObject({
      outcome: 'failed',
      errorCode: 'TRANSCODE_FAILED',
    });
    const row = await prisma.video.findUniqueOrThrow({ where: { id } });
    expect(row.hlsMasterKey).toBeNull();
    expect(storageService.putObject).not.toHaveBeenCalled();
  });

  // Proof 8: invalid playlist prevents promotion.
  it('a broken variant playlist fails local validation and prevents promotion', async () => {
    const id = `${testIdPrefix}-invalid-playlist`;
    await createFixtureVideo(id, {
      processingState: 'queued',
      processingVersion: 1,
    });
    const storageService = fakeStorageService();
    const brokenEncoder: HlsEncoderClient = {
      encodeRung: jest.fn(async (request: HlsEncodeRungRequest) => {
        await mkdir(request.outputDir, { recursive: true });
        await writeFile(
          join(request.outputDir, 'init.mp4'),
          Buffer.alloc(200, 1),
        );
        await writeFile(
          join(request.outputDir, 'seg_00000.m4s'),
          Buffer.alloc(1000, 2),
        );
        // No #EXT-X-MAP line — an invalid/incomplete playlist.
        await writeFile(
          join(request.outputDir, 'index.m3u8'),
          '#EXTM3U\n#EXT-X-ENDLIST\n',
        );
      }),
    };
    const processor = buildProcessor({
      storageService,
      encoderClient: brokenEncoder,
    });

    const outcome = await processor.process({
      videoId: id,
      processingVersion: 1,
    });

    expect(outcome).toMatchObject({
      outcome: 'failed',
      errorCode: 'HLS_PACKAGE_VALIDATION_FAILED',
    });
    const row = await prisma.video.findUniqueOrThrow({ where: { id } });
    expect(row.hlsMasterKey).toBeNull();
    // Default maxAttempts is 3 — attempt 1 is retryable, not terminal.
    expect(row.processingState).toBe('queued');
    expect(row.processingErrorCode).toBe('HLS_PACKAGE_VALIDATION_FAILED');
  });

  // Proof 9: incomplete artifact set prevents promotion.
  it('a missing media segment fails local validation and prevents promotion', async () => {
    const id = `${testIdPrefix}-missing-segment`;
    await createFixtureVideo(id, {
      processingState: 'queued',
      processingVersion: 1,
    });
    const storageService = fakeStorageService();
    const incompleteEncoder: HlsEncoderClient = {
      encodeRung: jest.fn(async (request: HlsEncodeRungRequest) => {
        await mkdir(request.outputDir, { recursive: true });
        await writeFile(
          join(request.outputDir, 'init.mp4'),
          Buffer.alloc(200, 1),
        );
        // seg_00000.m4s deliberately NOT written — incomplete artifact set.
        const playlist = [
          '#EXTM3U',
          '#EXT-X-VERSION:7',
          '#EXT-X-MAP:URI="init.mp4"',
          '#EXTINF:4.000,',
          'seg_00000.m4s',
          '#EXT-X-ENDLIST',
          '',
        ].join('\n');
        await writeFile(join(request.outputDir, 'index.m3u8'), playlist);
      }),
    };
    const processor = buildProcessor({
      storageService,
      encoderClient: incompleteEncoder,
    });

    const outcome = await processor.process({
      videoId: id,
      processingVersion: 1,
    });

    expect(outcome).toMatchObject({
      outcome: 'failed',
      errorCode: 'HLS_PACKAGE_VALIDATION_FAILED',
    });
    const row = await prisma.video.findUniqueOrThrow({ where: { id } });
    expect(row.hlsMasterKey).toBeNull();
  });

  // Proof 10: pointer flip is version/CAS-guarded.
  it('promotion only flips hlsMasterKey when the row is still exactly the expected version/state', async () => {
    const id = `${testIdPrefix}-promotion-cas`;
    await createFixtureVideo(id, {
      processingState: 'queued',
      processingVersion: 1,
    });
    const storageService = fakeStorageService();
    const processor = buildProcessor({ storageService });

    const outcome = await processor.process({
      videoId: id,
      processingVersion: 1,
    });

    expect(outcome.outcome).toBe('promoted');
    const row = await prisma.video.findUniqueOrThrow({ where: { id } });
    expect(row.processingState).toBe('ready');
    expect(row.hlsMasterKey).toContain(`admin-media/${id}/hls/v1-a1-`);
    expect(row.hlsMasterKey).toMatch(/\/master\.m3u8$/);
    // bandwidth = ceil((maxrateKbps*1000 + audioBitrateBps) * 1.05)
    //           = ceil((900_000 + 96_000) * 1.05) = 1_045_800
    expect(row.hlsRenditions).toEqual([
      { name: '360p', width: 360, height: 640, bandwidth: 1_045_800 },
    ]);
    expect(row.transcodeProfileVersion).toBe('ladder-v1');
    expect(row.processingStep).toBeNull();
  });

  it('a promotion race (row superseded right before the flip) is reported as superseded, not promoted or failed', async () => {
    const id = `${testIdPrefix}-promotion-race`;
    await createFixtureVideo(id, {
      processingState: 'queued',
      processingVersion: 1,
    });
    const storageService = fakeStorageService();
    // Simulate "someone else superseded this row" firing exactly at the
    // promotion instant — a clean subclass override (not a jest spy/bind,
    // which degrade TypeScript's ability to type-check the override) that
    // bumps the row's version out from under the job immediately before
    // delegating to the real, unmodified `promoteIfCurrent` CAS — mirroring
    // a genuine race window, and still exercising the REAL CAS write (which
    // must itself observe the now-stale version and affect zero rows).
    class RacyTranscodeIntentService extends TranscodeIntentService {
      async promoteIfCurrent(
        videoId: string,
        expectedVersion: number,
        result: {
          hlsMasterKey: string;
          hlsRenditions: HlsRenditionSummary[];
          transcodeProfileVersion: string;
        },
      ): Promise<number> {
        await prisma.video.update({
          where: { id: videoId },
          data: { processingVersion: 999 },
        });
        return super.promoteIfCurrent(videoId, expectedVersion, result);
      }
    }
    const intentService = new RacyTranscodeIntentService(prisma, queue);

    const processor = new TranscodeJobProcessor(
      prisma,
      buildConfigService(buildTranscodeConfig()),
      intentService,
      storageService as unknown as StorageService,
      fakeProbeClient(),
      new HlsTranscodeService(fakeEncoder()),
      new MasterPlaylistService(),
      new HlsPackageValidator(fakeProbeClient()),
      fakeThumbnailClient().client,
    );

    const outcome = await processor.process({
      videoId: id,
      processingVersion: 1,
    });

    expect(outcome).toEqual({
      outcome: 'superseded',
      reason: 'PROMOTION_RACE_LOST',
    });
    // Its own staging was cleaned up rather than left orphaned.
    expect(storageService.deleteObject).toHaveBeenCalled();
  });

  describe('poster generation (proof: thumbnail failure fails the job)', () => {
    it('generates and uploads a poster when the row has none yet', async () => {
      const id = `${testIdPrefix}-poster-generated`;
      await createFixtureVideo(id, {
        processingState: 'queued',
        processingVersion: 1,
        thumbnailImageKey: null,
      });
      const storageService = fakeStorageService();
      const processor = buildProcessor({ storageService });

      const outcome = await processor.process({
        videoId: id,
        processingVersion: 1,
      });

      expect(outcome.outcome).toBe('promoted');
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.thumbnailImageKey).toBe(`admin-media/${id}/thumbnail`);
    });

    it('skips poster generation when the row already has a thumbnailImageKey', async () => {
      const id = `${testIdPrefix}-poster-skip`;
      const existingKey = `admin-media/${id}/thumbnail`;
      await createFixtureVideo(id, {
        processingState: 'queued',
        processingVersion: 1,
        thumbnailImageKey: existingKey,
      });
      const storageService = fakeStorageService();
      const { client: thumbnailClient, generateMock } = fakeThumbnailClient();
      const processor = buildProcessor({ storageService, thumbnailClient });

      const outcome = await processor.process({
        videoId: id,
        processingVersion: 1,
      });

      expect(outcome.outcome).toBe('promoted');
      expect(generateMock).not.toHaveBeenCalled();
    });

    it('a poster generation failure fails the whole job (frozen arch: publish needs a poster)', async () => {
      const id = `${testIdPrefix}-poster-fails`;
      await createFixtureVideo(id, {
        processingState: 'queued',
        processingVersion: 1,
        thumbnailImageKey: null,
      });
      const storageService = fakeStorageService();
      const failingThumbnailClient: ThumbnailClient = {
        generate: jest
          .fn<Promise<ThumbnailArtifact>, [ThumbnailGenerateRequest]>()
          .mockRejectedValue(new Error('ffmpeg thumbnail failed')),
      };
      const processor = buildProcessor({
        storageService,
        thumbnailClient: failingThumbnailClient,
      });

      const outcome = await processor.process({
        videoId: id,
        processingVersion: 1,
      });

      expect(outcome).toMatchObject({
        outcome: 'failed',
        errorCode: 'POSTER_GENERATION_FAILED',
      });
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.hlsMasterKey).toBeNull();
    });
  });

  describe('attempt cap (MAX_ATTEMPTS_EXCEEDED)', () => {
    it('refuses to run FFmpeg once the claimed attempt would exceed TRANSCODE_MAX_ATTEMPTS', async () => {
      const id = `${testIdPrefix}-max-attempts`;
      await createFixtureVideo(id, {
        processingState: 'queued',
        processingVersion: 1,
        processingAttempts: 3, // already at the cap — the next claim would be attempt 4
      });
      const storageService = fakeStorageService();
      const processor = buildProcessor({
        storageService,
        transcodeConfig: buildTranscodeConfig({ maxAttempts: 3 }),
      });

      const outcome = await processor.process({
        videoId: id,
        processingVersion: 1,
      });

      expect(outcome).toEqual({
        outcome: 'failed',
        errorCode: 'MAX_ATTEMPTS_EXCEEDED',
        terminal: true,
      });
      expect(storageService.downloadObjectToFile).not.toHaveBeenCalled();
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingState).toBe('failed');
    });
  });

  describe('superseded outcomes', () => {
    it('reports ROW_NOT_FOUND for a videoId that does not exist', async () => {
      const outcome = await buildProcessor({
        storageService: fakeStorageService(),
      }).process({
        videoId: `${testIdPrefix}-does-not-exist`,
        processingVersion: 1,
      });

      expect(outcome).toEqual({
        outcome: 'superseded',
        reason: 'ROW_NOT_FOUND',
      });
    });

    it('reports NOT_QUEUED when the row is not currently "queued"', async () => {
      const id = `${testIdPrefix}-not-queued`;
      await createFixtureVideo(id, {
        processingState: 'running',
        processingVersion: 1,
      });

      const outcome = await buildProcessor({
        storageService: fakeStorageService(),
      }).process({
        videoId: id,
        processingVersion: 1,
      });

      expect(outcome).toEqual({ outcome: 'superseded', reason: 'NOT_QUEUED' });
    });

    it('SOURCE_MISSING when the source object cannot be downloaded', async () => {
      const id = `${testIdPrefix}-source-missing`;
      await createFixtureVideo(id, {
        processingState: 'queued',
        processingVersion: 1,
      });
      const storageService = fakeStorageService({
        downloadObjectToFile: jest
          .fn()
          .mockRejectedValue(new Error('NoSuchKey')),
      });
      const processor = buildProcessor({ storageService });

      const outcome = await processor.process({
        videoId: id,
        processingVersion: 1,
      });

      expect(outcome).toMatchObject({
        outcome: 'failed',
        errorCode: 'SOURCE_MISSING',
      });
    });

    it('PROBE_FAILED when ffprobe fails', async () => {
      const id = `${testIdPrefix}-probe-failed`;
      await createFixtureVideo(id, {
        processingState: 'queued',
        processingVersion: 1,
      });
      const storageService = fakeStorageService();
      const failingProbe: HlsProbeClient = {
        probe: jest.fn().mockRejectedValue(new Error('corrupt file')),
      };
      const processor = buildProcessor({
        storageService,
        probeClient: failingProbe,
      });

      const outcome = await processor.process({
        videoId: id,
        processingVersion: 1,
      });

      expect(outcome).toMatchObject({
        outcome: 'failed',
        errorCode: 'PROBE_FAILED',
      });
    });
  });

  // Proof 17: secrets never appear in logs/health/errors — this class's own
  // slice of that proof (full cross-cutting sentinel coverage lives in
  // `log-redaction.e2e-spec.ts`). A presigned-URL-shaped sentinel is what a
  // real AWS SDK error can plausibly embed (the SDK sometimes echoes the
  // signed request URL in its error message).
  describe('proof 17: secrets never reach processingErrorMessage or this class’s logs', () => {
    it('redacts a presigned-URL-shaped credential out of both the log line and the persisted processingErrorMessage', async () => {
      const id = `${testIdPrefix}-secret-in-error`;
      await createFixtureVideo(id, {
        processingState: 'queued',
        processingVersion: 1,
      });
      const sentinel = 'SENTINEL-DO-NOT-LEAK-4f9c9x';
      const storageService = fakeStorageService({
        downloadObjectToFile: jest
          .fn()
          .mockRejectedValue(
            new Error(
              `PUT https://bucket.r2.example/key?X-Amz-Signature=${sentinel}&X-Amz-Expires=900 failed with 403`,
            ),
          ),
      });
      const processor = buildProcessor({ storageService });
      const warnSpy = jest.spyOn(
        (
          processor as unknown as {
            logger: { warn: (...a: unknown[]) => void };
          }
        ).logger,
        'warn',
      );

      await processor.process({ videoId: id, processingVersion: 1 });

      const loggedTexts = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(loggedTexts.some((text) => text.includes('SOURCE_MISSING'))).toBe(
        true,
      );
      expect(loggedTexts.join(' ')).not.toContain(sentinel);

      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingErrorCode).toBe('SOURCE_MISSING');
      expect(row.processingErrorMessage).not.toContain(sentinel);
      expect(row.processingErrorMessage).toContain('[REDACTED]');
    });
  });

  /**
   * VPS DEPLOYMENT (work unit "TRANSCODE WORKER VPS DEPLOYMENT") — the temp
   * lifecycle and the structured event stream, both of which an unattended
   * box depends on and neither of which any existing test covered.
   */
  describe('temp working directory and structured job events (VPS deployment)', () => {
    function captureEvents(processor: TranscodeJobProcessor): string[] {
      const lines: string[] = [];
      jest
        .spyOn(
          (
            processor as unknown as {
              logger: { log: (...a: unknown[]) => void };
            }
          ).logger,
          'log',
        )
        .mockImplementation((...args: unknown[]) => {
          lines.push(String(args[0]));
        });
      return lines;
    }

    function jobEvents(lines: string[]): Record<string, unknown>[] {
      return lines
        .filter((line) => line.startsWith(`${TRANSCODE_JOB_LOG_TAG} `))
        .map(
          (line) =>
            JSON.parse(line.slice(TRANSCODE_JOB_LOG_TAG.length + 1)) as Record<
              string,
              unknown
            >,
        );
    }

    // Every job gets its OWN mkdtemp directory, and it is gone afterwards.
    // Without this, a box running an unattended wave accumulates a full
    // source plus a full HLS package per job until the disk fills.
    it('creates the job temp directory under the configured root and removes it after a SUCCESSFUL job', async () => {
      const id = `${testIdPrefix}-temp-success`;
      await createFixtureVideo(id, {
        processingState: 'queued',
        processingVersion: 1,
      });
      const tempRoot = await mkdtemp(join(tmpdir(), 'processor-temp-root-'));
      const storageService = fakeStorageService();
      const processor = buildProcessor({
        storageService,
        transcodeConfig: buildTranscodeConfig({ tempDir: tempRoot }),
      });

      const outcome = await processor.process({
        videoId: id,
        processingVersion: 1,
      });

      expect(outcome.outcome).toBe('promoted');
      await expect(readdir(tempRoot)).resolves.toEqual([]);
    });

    it('removes the job temp directory after a FAILED job too', async () => {
      const id = `${testIdPrefix}-temp-failure`;
      await createFixtureVideo(id, {
        processingState: 'queued',
        processingVersion: 1,
      });
      const tempRoot = await mkdtemp(join(tmpdir(), 'processor-temp-root-'));
      const storageService = fakeStorageService({
        downloadObjectToFile: jest
          .fn()
          .mockRejectedValue(new Error('source is gone')),
      });
      const processor = buildProcessor({
        storageService,
        transcodeConfig: buildTranscodeConfig({ tempDir: tempRoot }),
      });

      const outcome = await processor.process({
        videoId: id,
        processingVersion: 1,
      });

      expect(outcome).toMatchObject({
        outcome: 'failed',
        errorCode: 'SOURCE_MISSING',
      });
      await expect(readdir(tempRoot)).resolves.toEqual([]);
    });

    // THE DIAGNOSTICS-BEFORE-CLEANUP ORDERING. Removing the temp directory
    // is unconditional, so the failure's diagnostic state must already be
    // durable when it happens — otherwise a failed job on an unattended box
    // leaves nothing at all to debug.
    it('captures the failure diagnostics (durable row + structured event) BEFORE the temp directory is cleaned up', async () => {
      const id = `${testIdPrefix}-temp-diagnostics`;
      await createFixtureVideo(id, {
        processingState: 'queued',
        processingVersion: 1,
      });
      const tempRoot = await mkdtemp(join(tmpdir(), 'processor-temp-root-'));
      const storageService = fakeStorageService({
        downloadObjectToFile: jest
          .fn()
          .mockRejectedValue(new Error('source is gone')),
      });
      const processor = buildProcessor({
        storageService,
        transcodeConfig: buildTranscodeConfig({ tempDir: tempRoot }),
      });
      const lines = captureEvents(processor);

      await processor.process({ videoId: id, processingVersion: 1 });

      // The event exists...
      const failure = jobEvents(lines).find((e) => e.outcome === 'failed');
      expect(failure).toMatchObject({
        videoId: id,
        stage: 'download',
        failureCategory: 'SOURCE_MISSING',
      });
      // ...the durable row carries the same category...
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingErrorCode).toBe('SOURCE_MISSING');
      // ...and only then is the scratch gone.
      await expect(readdir(tempRoot)).resolves.toEqual([]);
    });

    it('emits an accepted event and a promoted event carrying job id, generation, stage and duration', async () => {
      const id = `${testIdPrefix}-events-success`;
      await createFixtureVideo(id, {
        processingState: 'queued',
        processingVersion: 1,
      });
      const storageService = fakeStorageService();
      const processor = buildProcessor({ storageService });
      const lines = captureEvents(processor);

      await processor.process({ videoId: id, processingVersion: 1 });

      const events = jobEvents(lines);
      const accepted = events.find((e) => e.outcome === 'accepted');
      const promoted = events.find((e) => e.outcome === 'promoted');

      expect(accepted).toMatchObject({
        videoId: id,
        jobId: buildTranscodeJobId(id, 1),
        stage: 'claim',
        attempt: 1,
      });
      expect(promoted).toMatchObject({
        videoId: id,
        jobId: buildTranscodeJobId(id, 1),
        stage: 'promote',
      });
      expect(typeof promoted?.durationMs).toBe('number');

      // The generation NAMED in the event must be the R2 directory the row
      // now points at — otherwise an operator chasing a job into the bucket
      // looks in the wrong place.
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.hlsMasterKey).toContain(String(promoted?.generation));
    });

    it('emits a claim-stage superseded event, with a null generation, when the row was already claimed', async () => {
      const id = `${testIdPrefix}-events-superseded`;
      await createFixtureVideo(id, {
        processingState: 'running',
        processingVersion: 1,
      });
      const processor = buildProcessor({
        storageService: fakeStorageService(),
      });
      const lines = captureEvents(processor);

      await processor.process({ videoId: id, processingVersion: 1 });

      expect(jobEvents(lines)).toEqual([
        expect.objectContaining({
          videoId: id,
          generation: null,
          stage: 'claim',
          outcome: 'superseded',
          failureCategory: 'NOT_QUEUED',
        }),
      ]);
    });
  });
});
