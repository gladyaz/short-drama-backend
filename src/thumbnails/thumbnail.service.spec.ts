import { execFile, execFileSync } from 'child_process';
import { mkdtemp, readdir, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { Test, TestingModule } from '@nestjs/testing';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { StorageService } from '../storage/storage.service';
import { FfmpegThumbnailCliClient } from './ffmpeg-thumbnail-cli.client';
import {
  DEFAULT_THUMBNAIL_TIMESTAMP_SECONDS,
  DEFAULT_THUMBNAIL_WIDTH,
  THUMBNAIL_TEMP_DIR_PREFIX,
} from './thumbnail.constants';
import { buildThumbnailStorageKey } from './thumbnail-storage-key.util';
import { ThumbnailService } from './thumbnail.service';
import { THUMBNAIL_CLIENT } from './thumbnail.types';
import type {
  ThumbnailArtifact,
  ThumbnailGenerateRequest,
} from './thumbnail.types';

const execFileAsync = promisify(execFile);

type GenerateMock = jest.Mock<
  Promise<ThumbnailArtifact>,
  [ThumbnailGenerateRequest]
>;
type PutObjectMock = jest.Mock<
  Promise<void>,
  [string, Buffer, (string | undefined)?]
>;

/** Fixed, deterministic fixture height the mock client returns by default. */
const FIXTURE_HEIGHT = 270;

/**
 * Writes a fake output file at `request.outputPath`, mirroring what a real
 * `ThumbnailClient` implementation does, so `ThumbnailService`'s
 * `readFile(artifact.outputPath)` step has something real to read.
 */
async function defaultGenerateImpl(
  request: ThumbnailGenerateRequest,
): Promise<ThumbnailArtifact> {
  await writeFile(request.outputPath, Buffer.from('fake-thumbnail-bytes'));
  return {
    outputPath: request.outputPath,
    width: request.width,
    height: FIXTURE_HEIGHT,
  };
}

/** Every `thumbnail-*` directory currently under `os.tmpdir()`. */
async function listThumbnailTempDirs(): Promise<string[]> {
  const entries = await readdir(tmpdir());
  return entries.filter((entry) => entry.startsWith(THUMBNAIL_TEMP_DIR_PREFIX));
}

function isFfmpegAvailable(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Phase 11, work unit 11D-2b: `ThumbnailClient` and `StorageService` are
 * entirely mocked in this primary suite — no test here requires `ffmpeg` to
 * be installed, and no test ever makes a real R2/network call (see
 * `ffmpeg-thumbnail-cli.client.ts`'s doc comment: it is not constructed
 * anywhere in this `describe` block). Every generated artifact lives inside
 * a fresh, real `fs.mkdtemp` temp directory that this suite asserts is
 * fully removed afterward, whether the call succeeded or failed. The
 * source "video" fixture files created here are plain placeholder bytes —
 * their content is never actually read by the mocked client, only their
 * existence/extension is validated by `ThumbnailService` itself.
 */
describe('ThumbnailService', () => {
  let service: ThumbnailService;
  let generateMock: GenerateMock;
  let putObjectMock: PutObjectMock;
  let fixtureDir: string;
  let inputPath: string;
  let baselineTempDirs: string[];

  beforeEach(async () => {
    generateMock = jest.fn<
      Promise<ThumbnailArtifact>,
      [ThumbnailGenerateRequest]
    >();
    generateMock.mockImplementation(defaultGenerateImpl);
    putObjectMock = jest.fn<
      Promise<void>,
      [string, Buffer, (string | undefined)?]
    >();
    putObjectMock.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThumbnailService,
        { provide: THUMBNAIL_CLIENT, useValue: { generate: generateMock } },
        { provide: StorageService, useValue: { putObject: putObjectMock } },
      ],
    }).compile();

    service = module.get<ThumbnailService>(ThumbnailService);

    fixtureDir = await mkdtemp(join(tmpdir(), 'thumbnail-fixture-'));
    inputPath = join(fixtureDir, 'source.mp4');
    await writeFile(inputPath, Buffer.from('fake-source-video-bytes'));

    baselineTempDirs = await listThumbnailTempDirs();
  });

  afterEach(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  describe('input validation', () => {
    it('throws MEDIA_FILE_NOT_FOUND when the source video does not exist', async () => {
      const missingPath = join(fixtureDir, 'does-not-exist.mp4');

      let caught: unknown;
      try {
        await service.generate({ inputPath: missingPath, assetId: 'asset-1' });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AppException);
      expect((caught as AppException).code).toBe(
        AppErrorCode.MEDIA_FILE_NOT_FOUND,
      );
      expect(generateMock).not.toHaveBeenCalled();
      expect(putObjectMock).not.toHaveBeenCalled();
    });

    it('throws UNSUPPORTED_MEDIA_FORMAT for a non-video extension', async () => {
      const textPath = join(fixtureDir, 'not-a-video.txt');
      await writeFile(textPath, 'hello');

      let caught: unknown;
      try {
        await service.generate({ inputPath: textPath, assetId: 'asset-1' });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AppException);
      expect((caught as AppException).code).toBe(
        AppErrorCode.UNSUPPORTED_MEDIA_FORMAT,
      );
      expect(generateMock).not.toHaveBeenCalled();
      expect(putObjectMock).not.toHaveBeenCalled();
    });

    it('throws INVALID_THUMBNAIL_TIMESTAMP for a negative timestamp override', async () => {
      let caught: unknown;
      try {
        await service.generate({
          inputPath,
          assetId: 'asset-1',
          timestampSeconds: -1,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AppException);
      expect((caught as AppException).code).toBe(
        AppErrorCode.INVALID_THUMBNAIL_TIMESTAMP,
      );
      expect(generateMock).not.toHaveBeenCalled();
    });
  });

  describe('timestamp selection', () => {
    it('uses the configurable default timestamp when none is provided', async () => {
      await service.generate({ inputPath, assetId: 'asset-1' });

      expect(generateMock).toHaveBeenCalledTimes(1);
      expect(generateMock.mock.calls[0][0].timestampSeconds).toBe(
        DEFAULT_THUMBNAIL_TIMESTAMP_SECONDS,
      );
    });

    it('honors a caller-supplied timestamp override', async () => {
      await service.generate({
        inputPath,
        assetId: 'asset-1',
        timestampSeconds: 12,
      });

      expect(generateMock.mock.calls[0][0].timestampSeconds).toBe(12);
    });
  });

  describe('deterministic output key', () => {
    it('produces the same key for the same assetId + width variant across calls', async () => {
      const first = await service.generate({ inputPath, assetId: 'asset-42' });
      const second = await service.generate({ inputPath, assetId: 'asset-42' });

      const expectedKey = buildThumbnailStorageKey(
        'asset-42',
        `w${DEFAULT_THUMBNAIL_WIDTH}`,
      );
      expect(first.key).toBe(expectedKey);
      expect(second.key).toBe(expectedKey);
      expect(putObjectMock).toHaveBeenNthCalledWith(
        1,
        expectedKey,
        expect.any(Buffer),
        'image/jpeg',
      );
      expect(putObjectMock).toHaveBeenNthCalledWith(
        2,
        expectedKey,
        expect.any(Buffer),
        'image/jpeg',
      );
    });

    it('produces a different key for a different width variant of the same asset', async () => {
      const defaultWidth = await service.generate({
        inputPath,
        assetId: 'asset-7',
      });
      const customWidth = await service.generate({
        inputPath,
        assetId: 'asset-7',
        width: 720,
      });

      expect(defaultWidth.key).not.toBe(customWidth.key);
    });
  });

  describe('successful generation', () => {
    it('returns the measured output dimensions from the client', async () => {
      generateMock.mockImplementation(async (request) => {
        await writeFile(request.outputPath, Buffer.from('bytes'));
        return {
          outputPath: request.outputPath,
          width: request.width,
          height: 853,
        };
      });

      const result = await service.generate({ inputPath, assetId: 'asset-9' });

      expect(result.width).toBe(DEFAULT_THUMBNAIL_WIDTH);
      expect(result.height).toBe(853);
      expect(result.contentType).toBe('image/jpeg');
    });

    it('calls putObject with the deterministic key, a Buffer body, and image/jpeg content type', async () => {
      const result = await service.generate({ inputPath, assetId: 'asset-9' });

      expect(putObjectMock).toHaveBeenCalledTimes(1);
      expect(putObjectMock).toHaveBeenCalledWith(
        result.key,
        expect.any(Buffer),
        'image/jpeg',
      );
    });

    it('leaves no stray temp directory behind after a successful ingest', async () => {
      await service.generate({ inputPath, assetId: 'asset-9' });

      expect(await listThumbnailTempDirs()).toEqual(baselineTempDirs);
    });

    it('never writes to, moves, or deletes the source input file', async () => {
      const before = await stat(inputPath);

      await service.generate({ inputPath, assetId: 'asset-9' });

      const after = await stat(inputPath);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(after.size).toBe(before.size);
    });
  });

  describe('dimension validation', () => {
    it('throws THUMBNAIL_DIMENSION_MISMATCH when the client returns a width that does not match the request', async () => {
      generateMock.mockImplementation(async (request) => {
        await writeFile(request.outputPath, Buffer.from('bytes'));
        return { outputPath: request.outputPath, width: 999, height: 500 };
      });

      let caught: unknown;
      try {
        await service.generate({ inputPath, assetId: 'asset-1' });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AppException);
      expect((caught as AppException).code).toBe(
        AppErrorCode.THUMBNAIL_DIMENSION_MISMATCH,
      );
      expect(putObjectMock).not.toHaveBeenCalled();
      expect(await listThumbnailTempDirs()).toEqual(baselineTempDirs);
    });

    it('throws THUMBNAIL_DIMENSION_MISMATCH for a non-positive height', async () => {
      generateMock.mockImplementation(async (request) => {
        await writeFile(request.outputPath, Buffer.from('bytes'));
        return {
          outputPath: request.outputPath,
          width: request.width,
          height: 0,
        };
      });

      await expect(
        service.generate({ inputPath, assetId: 'asset-1' }),
      ).rejects.toMatchObject({
        code: AppErrorCode.THUMBNAIL_DIMENSION_MISMATCH,
      });
    });
  });

  describe('cleanup on failure', () => {
    it('leaves no stray temp directory when the ThumbnailClient rejects', async () => {
      generateMock.mockRejectedValue(new Error('ffmpeg crashed'));

      let caught: unknown;
      try {
        await service.generate({ inputPath, assetId: 'asset-1' });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AppException);
      expect((caught as AppException).code).toBe(
        AppErrorCode.THUMBNAIL_GENERATION_FAILED,
      );
      expect(putObjectMock).not.toHaveBeenCalled();
      expect(await listThumbnailTempDirs()).toEqual(baselineTempDirs);
    });

    it('leaves no stray temp directory when StorageService.putObject rejects', async () => {
      putObjectMock.mockRejectedValue(new Error('network down'));

      let caught: unknown;
      try {
        await service.generate({ inputPath, assetId: 'asset-1' });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AppException);
      expect((caught as AppException).code).toBe(
        AppErrorCode.THUMBNAIL_GENERATION_FAILED,
      );
      expect(await listThumbnailTempDirs()).toEqual(baselineTempDirs);
    });

    it('never lets a raw underlying error message (which could contain a filesystem path) reach the thrown AppException', async () => {
      generateMock.mockRejectedValue(
        new Error(`Command failed: ffmpeg -i ${inputPath} ...`),
      );

      let caught: unknown;
      try {
        await service.generate({ inputPath, assetId: 'asset-1' });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AppException);
      expect((caught as AppException).message).not.toContain(inputPath);
    });
  });
});

/**
 * OPTIONAL real-ffmpeg integration test. Auto-skips (via `describe.skip`)
 * when `ffmpeg`/`ffprobe` are not found on `PATH`, so this file's primary
 * suite above never depends on either binary being installed. When ffmpeg
 * IS available (confirmed here via `execFileSync`), this generates a real,
 * tiny synthetic input with `ffmpeg -f lavfi ... testsrc`, runs the REAL
 * `FfmpegThumbnailCliClient` (not a mock), and asserts a real output frame
 * exists on disk with the expected width. Entirely self-contained inside a
 * temp directory it creates and removes itself; never touches
 * `STORAGE_ROOT` or any real company video.
 */
const maybeDescribe = isFfmpegAvailable() ? describe : describe.skip;

maybeDescribe(
  'FfmpegThumbnailCliClient (real ffmpeg, auto-skips if unavailable)',
  () => {
    let tempDir: string;
    let syntheticInputPath: string;

    beforeAll(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'thumbnail-ffmpeg-it-'));
      syntheticInputPath = join(tempDir, 'synthetic-input.mp4');

      await execFileAsync('ffmpeg', [
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=1:size=320x240:rate=10',
        '-y',
        syntheticInputPath,
      ]);
    }, 30000);

    afterAll(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('generates a real thumbnail frame at the expected width', async () => {
      const client = new FfmpegThumbnailCliClient();
      const outputPath = join(tempDir, 'output.jpg');

      const artifact = await client.generate({
        inputPath: syntheticInputPath,
        outputPath,
        timestampSeconds: 0,
        width: 160,
      });

      expect(artifact.outputPath).toBe(outputPath);
      expect(artifact.width).toBe(160);
      expect(artifact.height).toBeGreaterThan(0);

      const stats = await stat(outputPath);
      expect(stats.isFile()).toBe(true);
      expect(stats.size).toBeGreaterThan(0);
    }, 30000);
  },
);
