import type { Stats } from 'fs';
import { mkdtemp, readdir, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { AppException } from '../common/errors/app.exception';
import { AppErrorCode } from '../common/errors/app-error-code';
import { FFPROBE_CLIENT, FfprobeMetadata } from './importer.types';
import { MediaDryRunService } from './media-dryrun.service';

type ProbeMock = jest.Mock<Promise<FfprobeMetadata>, [string]>;

const FIXTURE_METADATA: FfprobeMetadata = {
  durationSeconds: 87,
  width: 720,
  height: 1280,
};

const FIXTURE_DIR_PREFIX = 'media-dryrun-fixture-';

interface FileSnapshot {
  name: string;
  size: number;
  mtimeMs: number;
}

async function snapshotFolder(folderPath: string): Promise<FileSnapshot[]> {
  const names = (await readdir(folderPath)).sort();
  const stats: FileSnapshot[] = [];
  for (const name of names) {
    const fileStats: Stats = await stat(join(folderPath, name));
    stats.push({ name, size: fileStats.size, mtimeMs: fileStats.mtimeMs });
  }
  return stats;
}

/**
 * Phase 11, work unit 11D-1-dryrun: every test in this file runs against a
 * throwaway `fs.mkdtemp` folder under `os.tmpdir()`, never against
 * `STORAGE_ROOT` or any real company video. `FfprobeClient` is entirely
 * mocked — no test here requires `ffmpeg`/`ffprobe` to be installed. The
 * `TestingModule` below provides only `MediaDryRunService` + the mocked
 * `FFPROBE_CLIENT` token — deliberately no `PrismaService` — so a
 * structural regression (someone adding a `PrismaService` dependency to
 * the constructor) would fail this module's `.compile()`, not just go
 * unnoticed.
 */
describe('MediaDryRunService', () => {
  let service: MediaDryRunService;
  let probeMock: ProbeMock;
  let folderPath: string;

  beforeEach(async () => {
    probeMock = jest.fn<Promise<FfprobeMetadata>, [string]>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaDryRunService,
        { provide: FFPROBE_CLIENT, useValue: { probe: probeMock } },
      ],
    }).compile();

    service = module.get<MediaDryRunService>(MediaDryRunService);

    folderPath = await mkdtemp(join(tmpdir(), FIXTURE_DIR_PREFIX));
    await writeFile(join(folderPath, '1.mp4'), '');
    await writeFile(join(folderPath, '2.mp4'), '');
    await writeFile(join(folderPath, '10.mp4'), '');
    await writeFile(join(folderPath, 'notes.txt'), 'not a video');
  });

  afterEach(async () => {
    await rm(folderPath, { recursive: true, force: true });
  });

  describe('discovery, ordering, and reporting', () => {
    it('discovers only the supported video files, ignoring non-video files', async () => {
      probeMock.mockResolvedValue(FIXTURE_METADATA);

      const report = await service.inspect(folderPath);

      expect(report.discoveredCount).toBe(3);
      expect(report.items.map((item) => item.fileName)).toEqual([
        '1.mp4',
        '2.mp4',
        '10.mp4',
      ]);
      expect(report.items.some((item) => item.fileName === 'notes.txt')).toBe(
        false,
      );
    });

    it('orders files with a natural sort (1, 2, 10 — not the lexical 1, 10, 2)', async () => {
      probeMock.mockResolvedValue(FIXTURE_METADATA);

      const report = await service.inspect(folderPath);

      expect(report.items.map((item) => item.proposedEpisodeNumber)).toEqual([
        1, 2, 3,
      ]);
      expect(report.items.map((item) => item.proposedSortOrder)).toEqual([
        0, 1, 2,
      ]);
    });

    it('reports per-item duration/width/height from the injected FfprobeClient', async () => {
      probeMock.mockResolvedValue(FIXTURE_METADATA);

      const report = await service.inspect(folderPath);

      for (const item of report.items) {
        expect(item.status).toBe('ok');
        if (item.status === 'ok') {
          expect(item.metadata).toEqual(FIXTURE_METADATA);
        }
      }
      expect(report.succeeded).toBe(3);
      expect(report.failed).toBe(0);
    });

    it('probes each discovered file at its absolute path', async () => {
      probeMock.mockResolvedValue(FIXTURE_METADATA);

      await service.inspect(folderPath);

      expect(probeMock).toHaveBeenCalledTimes(3);
      expect(probeMock).toHaveBeenNthCalledWith(1, join(folderPath, '1.mp4'));
      expect(probeMock).toHaveBeenNthCalledWith(2, join(folderPath, '2.mp4'));
      expect(probeMock).toHaveBeenNthCalledWith(3, join(folderPath, '10.mp4'));
    });

    it("computes the proposed storageKey as each file's path relative to the passed folder root", async () => {
      probeMock.mockResolvedValue(FIXTURE_METADATA);

      const report = await service.inspect(folderPath);

      expect(report.items.map((item) => item.proposedStorageKey)).toEqual([
        '1.mp4',
        '2.mp4',
        '10.mp4',
      ]);
    });
  });

  describe('read-only guarantee', () => {
    it('never adds, removes, renames, or modifies any file in the inspected folder', async () => {
      probeMock.mockResolvedValue(FIXTURE_METADATA);
      const before = await snapshotFolder(folderPath);

      await service.inspect(folderPath);

      const after = await snapshotFolder(folderPath);
      expect(after).toEqual(before);
    });

    it('performs no mutation even when a probe fails', async () => {
      probeMock.mockRejectedValue(new Error('corrupt file'));
      const before = await snapshotFolder(folderPath);

      await service.inspect(folderPath, { maxAttempts: 1 });

      const after = await snapshotFolder(folderPath);
      expect(after).toEqual(before);
    });
  });

  describe('no database access', () => {
    it('compiles with only the service + mocked FfprobeClient provided — no PrismaService', async () => {
      // Deliberately re-asserts the beforeEach setup's shape: if
      // MediaDryRunService's constructor ever required PrismaService, Nest
      // would throw "Nest can not resolve dependencies" here, since this
      // module never provides one.
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MediaDryRunService,
          { provide: FFPROBE_CLIENT, useValue: { probe: jest.fn() } },
        ],
      }).compile();

      expect(module.get(MediaDryRunService)).toBeInstanceOf(MediaDryRunService);
    });
  });

  describe('missing/invalid folder path', () => {
    it('throws a structured AppException when folderPath is empty', async () => {
      await expect(service.inspect('')).rejects.toBeInstanceOf(AppException);
      await expect(service.inspect('')).rejects.toMatchObject({
        code: AppErrorCode.DRY_RUN_FOLDER_PATH_REQUIRED,
      });
    });

    it('throws a structured AppException when folderPath is whitespace-only', async () => {
      await expect(service.inspect('   ')).rejects.toMatchObject({
        code: AppErrorCode.DRY_RUN_FOLDER_PATH_REQUIRED,
      });
    });

    it('throws a structured AppException when folderPath does not exist', async () => {
      const missingPath = join(folderPath, 'does-not-exist');

      await expect(service.inspect(missingPath)).rejects.toMatchObject({
        code: AppErrorCode.DRY_RUN_FOLDER_NOT_FOUND,
      });
    });

    it('throws a structured AppException when folderPath is a file, not a directory', async () => {
      const filePath = join(folderPath, '1.mp4');

      await expect(service.inspect(filePath)).rejects.toMatchObject({
        code: AppErrorCode.DRY_RUN_FOLDER_NOT_FOUND,
      });
    });

    it('never defaults to any path when folderPath is omitted', async () => {
      // @ts-expect-error deliberately calling without the required argument
      await expect(service.inspect()).rejects.toMatchObject({
        code: AppErrorCode.DRY_RUN_FOLDER_PATH_REQUIRED,
      });
    });
  });

  describe('one failed probe reported', () => {
    it('reports a single failing item without aborting the rest of the folder', async () => {
      probeMock.mockImplementation((sourcePath: string) => {
        if (sourcePath === join(folderPath, '2.mp4')) {
          return Promise.reject(new Error('corrupt file'));
        }
        return Promise.resolve(FIXTURE_METADATA);
      });

      const report = await service.inspect(folderPath, { maxAttempts: 2 });

      expect(report.succeeded).toBe(2);
      expect(report.failed).toBe(1);

      const failure = report.items.find((item) => item.fileName === '2.mp4');
      expect(failure).toEqual({
        fileName: '2.mp4',
        proposedEpisodeNumber: 2,
        proposedSortOrder: 1,
        proposedStorageKey: '2.mp4',
        status: 'probe_failed',
        attempts: 2,
        error: 'corrupt file',
      });

      const others = report.items.filter((item) => item.fileName !== '2.mp4');
      expect(others.every((item) => item.status === 'ok')).toBe(true);
    });

    it('retries up to maxAttempts and succeeds if a later attempt works', async () => {
      let callCount = 0;
      probeMock.mockImplementation(() => {
        callCount += 1;
        if (callCount < 3) {
          return Promise.reject(new Error('transient error'));
        }
        return Promise.resolve(FIXTURE_METADATA);
      });
      await rm(join(folderPath, '2.mp4'));
      await rm(join(folderPath, '10.mp4'));

      const report = await service.inspect(folderPath, { maxAttempts: 3 });

      expect(report.succeeded).toBe(1);
      expect(report.failed).toBe(0);
      expect(probeMock).toHaveBeenCalledTimes(3);
    });

    it('wraps a non-Error rejection into a string error message', async () => {
      probeMock.mockRejectedValue('a plain string rejection');
      await rm(join(folderPath, '2.mp4'));
      await rm(join(folderPath, '10.mp4'));

      const report = await service.inspect(folderPath, { maxAttempts: 1 });

      expect(report.items[0]).toMatchObject({
        status: 'probe_failed',
        error: 'a plain string rejection',
      });
    });
  });
});
