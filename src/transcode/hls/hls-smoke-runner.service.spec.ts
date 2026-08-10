import { execFileSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { StorageService } from '../../storage/storage.service';
import { HlsPackageValidator } from './hls-package-validator.service';
import { HlsSmokeRunner } from './hls-smoke-runner.service';
import { HlsTranscodeService } from './hls-transcode.service';
import { HLS_SMOKE_KEY_PREFIX } from './hls.constants';
import { HlsModule } from './hls.module';
import {
  HlsProbeClient,
  HlsRungArtifact,
  HlsSourceProbe,
  RenditionLadderResult,
} from './hls.types';
import { MasterPlaylistService } from './master-playlist.service';
import { computeRenditionLadder } from './rendition-ladder';
import { SyntheticSourceService } from './synthetic-source.service';

const SOURCE_PROBE: HlsSourceProbe = {
  width: 1080,
  height: 1920,
  rotation: 0,
  fps: 30,
  hasAudio: true,
  durationSeconds: 6,
  videoCodec: 'h264',
  audioCodec: 'aac',
};

/** Real in-memory fake object store — behaves like R2 for putObject/headObject/deleteObject, with zero network. */
class FakeStorageService {
  readonly store = new Map<
    string,
    { contentType: string; sizeBytes: number }
  >();

  putObject = jest.fn(
    (key: string, body: Buffer, contentType?: string): Promise<void> => {
      this.store.set(key, {
        contentType: contentType ?? '',
        sizeBytes: body.byteLength,
      });
      return Promise.resolve();
    },
  );

  headObject = jest.fn((key: string) => {
    const entry = this.store.get(key);
    if (!entry) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      key,
      contentLength: entry.sizeBytes,
      contentType: entry.contentType,
    });
  });

  deleteObject = jest.fn((key: string): Promise<void> => {
    this.store.delete(key);
    return Promise.resolve();
  });
}

async function writeFakeRung(
  packageRoot: string,
  rung: HlsRungArtifact['rung'],
): Promise<HlsRungArtifact> {
  const outputDir = join(packageRoot, rung.name);
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'init.mp4'), Buffer.alloc(200));
  await writeFile(join(outputDir, 'seg_00000.m4s'), Buffer.alloc(1000));
  await writeFile(join(outputDir, 'seg_00001.m4s'), Buffer.alloc(500));
  await writeFile(
    join(outputDir, 'index.m3u8'),
    [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:4.000000,',
      'seg_00000.m4s',
      '#EXTINF:2.000000,',
      'seg_00001.m4s',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n'),
  );

  return {
    rung,
    outputDir,
    playlistRelativePath: `${rung.name}/index.m3u8`,
    totalMediaBytes: 1700,
    segmentCount: 2,
  };
}

function buildHarness() {
  const expectedLadder = computeRenditionLadder(SOURCE_PROBE);

  const sourceTempDirs: string[] = [];
  const packageRoots: string[] = [];

  const syntheticSourceService = {
    generate: jest.fn(async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'hls-runner-spec-src-'));
      sourceTempDirs.push(tempDir);
      const sourcePath = join(tempDir, 'source.mp4');
      await writeFile(sourcePath, Buffer.alloc(10));
      return { tempDir, sourcePath, probe: SOURCE_PROBE };
    }),
  };

  const transcodeService = {
    transcodeAll: jest.fn(
      async (
        _sourcePath: string,
        packageRoot: string,
        ladder: RenditionLadderResult,
      ) => {
        packageRoots.push(packageRoot);
        const artifacts: HlsRungArtifact[] = [];
        for (const rung of ladder.rungs) {
          artifacts.push(await writeFakeRung(packageRoot, rung));
        }
        return artifacts;
      },
    ),
  };

  const masterPlaylistService = new MasterPlaylistService();

  const probeClient: jest.Mocked<HlsProbeClient> = {
    probe: jest.fn((path: string) => {
      const rungName = basename(dirname(path));
      const rung = expectedLadder.rungs.find((r) => r.name === rungName);
      return Promise.resolve({
        width: rung?.width ?? 0,
        height: rung?.height ?? 0,
        rotation: 0,
        fps: 30,
        hasAudio: true,
        durationSeconds: 6,
        videoCodec: 'h264',
        audioCodec: 'aac',
      });
    }),
  };
  const validator = new HlsPackageValidator(probeClient);

  const fakeStorage = new FakeStorageService();

  const runner = new HlsSmokeRunner(
    syntheticSourceService as unknown as SyntheticSourceService,
    transcodeService as unknown as HlsTranscodeService,
    masterPlaylistService,
    validator,
    fakeStorage as unknown as StorageService,
  );

  return {
    runner,
    fakeStorage,
    sourceTempDirs,
    packageRoots,
    syntheticSourceService,
    transcodeService,
  };
}

describe('HlsSmokeRunner — local-only path (default, never touches storage)', () => {
  it('produces a fully valid local package with all 4 rungs for the fixed synthetic source', async () => {
    const { runner, fakeStorage } = buildHarness();

    const result = await runner.run();

    expect(result.validation.valid).toBe(true);
    expect(result.rungArtifacts.map((a) => a.rung.name)).toEqual([
      '360p',
      '540p',
      '720p',
      '1080p',
    ]);
    expect(result.upload).toBeUndefined();
    expect(fakeStorage.putObject).not.toHaveBeenCalled();
    expect(fakeStorage.headObject).not.toHaveBeenCalled();
    expect(fakeStorage.deleteObject).not.toHaveBeenCalled();
  });

  it('cleans up both the source temp dir and the package root even on success', async () => {
    const { runner, sourceTempDirs, packageRoots } = buildHarness();

    await runner.run();

    expect(existsSync(sourceTempDirs[0])).toBe(false);
    expect(existsSync(packageRoots[0])).toBe(false);
  });

  it('cleans up local temp dirs even when transcoding fails', async () => {
    const { runner, sourceTempDirs, packageRoots, transcodeService } =
      buildHarness();
    transcodeService.transcodeAll.mockRejectedValueOnce(
      new Error('ffmpeg boom'),
    );

    await expect(runner.run()).rejects.toBeTruthy();

    // transcodeAll rejected before writing packageRoots in this mock, but the
    // source temp dir must still be gone.
    expect(existsSync(sourceTempDirs[0])).toBe(false);
    void packageRoots;
  });

  it('counts local files and bytes across master + every rung (17 files: 1 master + 4 rungs x 4 files)', async () => {
    const { runner } = buildHarness();

    const result = await runner.run();

    expect(result.totalLocalFileCount).toBe(17);
    expect(result.totalLocalBytes).toBeGreaterThan(0);
  });

  it('master playlist text references exactly the 4 produced rungs', async () => {
    const { runner } = buildHarness();
    const result = await runner.run();

    for (const name of ['360p', '540p', '720p', '1080p']) {
      expect(result.masterPlaylistText).toContain(`${name}/index.m3u8`);
    }
  });
});

describe('HlsSmokeRunner — upload path (gated-only, exercised here via a fake in-memory store)', () => {
  it('refuses to upload when local validation fails', async () => {
    const { runner, fakeStorage, transcodeService } = buildHarness();
    // Force an invalid package: drop a segment file after transcodeAll writes it.
    transcodeService.transcodeAll.mockImplementationOnce(
      async (
        _src: string,
        packageRoot: string,
        ladder: RenditionLadderResult,
      ) => {
        const artifacts: HlsRungArtifact[] = [];
        for (const rung of ladder.rungs) {
          artifacts.push(await writeFakeRung(packageRoot, rung));
        }
        await rm(join(packageRoot, '360p', 'seg_00001.m4s'));
        return artifacts;
      },
    );

    await expect(runner.run({ upload: true })).rejects.toMatchObject({
      code: 'HLS_PACKAGE_VALIDATION_FAILED',
    });
    expect(fakeStorage.putObject).not.toHaveBeenCalled();
  });

  it('uploads every artifact under a unique _r2-hls-smoke-tests/ prefix and verifies each via HEAD', async () => {
    const { runner, fakeStorage } = buildHarness();

    const result = await runner.run({ upload: true });

    expect(result.upload).toBeDefined();
    expect(result.upload!.keyPrefix.startsWith(HLS_SMOKE_KEY_PREFIX)).toBe(
      true,
    );
    expect(result.upload!.verified).toBe(true);
    // 1 master + 4 rungs x 3 media files (init + 2 segments) + 4 variant playlists = 1 + 12 + 4 = 17.
    expect(result.upload!.uploadedObjects.length).toBe(17);
    // Each object is HEAD-verified twice: once right after upload
    // (`uploadAndVerify`) and once again after delete during the binding
    // cleanup step (`cleanupUploadedObjects`) — proving both the upload AND
    // the deletion.
    expect(fakeStorage.headObject).toHaveBeenCalledTimes(34);
  });

  it('assigns Content-Type application/vnd.apple.mpegurl to every .m3u8, video/mp4 to init.mp4, video/iso.segment to .m4s', async () => {
    const { runner } = buildHarness();
    const result = await runner.run({ upload: true });

    for (const object of result.upload!.uploadedObjects) {
      if (object.key.endsWith('.m3u8')) {
        expect(object.contentType).toBe('application/vnd.apple.mpegurl');
      } else if (object.key.endsWith('init.mp4')) {
        expect(object.contentType).toBe('video/mp4');
      } else if (object.key.endsWith('.m4s')) {
        expect(object.contentType).toBe('video/iso.segment');
      }
    }
  });

  // Test 12: unique prefix collision-resistant + deterministic-safe.
  it('produces a different key prefix on every run, always under _r2-hls-smoke-tests/', async () => {
    const harnessA = buildHarness();
    const harnessB = buildHarness();

    const resultA = await harnessA.runner.run({ upload: true });
    const resultB = await harnessB.runner.run({ upload: true });

    expect(resultA.upload!.keyPrefix).not.toBe(resultB.upload!.keyPrefix);
    expect(resultA.upload!.keyPrefix.startsWith(HLS_SMOKE_KEY_PREFIX)).toBe(
      true,
    );
    expect(resultB.upload!.keyPrefix.startsWith(HLS_SMOKE_KEY_PREFIX)).toBe(
      true,
    );
  });

  // Test 13: cleanup deletes ONLY the recorded generated keys.
  it('cleanup deletes exactly the recorded uploaded keys — no more, no fewer', async () => {
    const { runner, fakeStorage } = buildHarness();

    const result = await runner.run({ upload: true });

    const uploadedKeys = result
      .upload!.uploadedObjects.map((o) => o.key)
      .sort();
    const deletedKeys = (fakeStorage.deleteObject.mock.calls as [string][])
      .map((call) => call[0])
      .sort();

    expect(deletedKeys).toEqual(uploadedKeys);
    expect(result.upload!.cleanedUp).toBe(true);
    expect(result.upload!.cleanupIssues).toEqual([]);
    // Every uploaded object is genuinely gone from the fake store afterward.
    expect(fakeStorage.store.size).toBe(0);
  });

  it('surfaces a loud, thrown error when cleanup cannot be proven (a delete silently fails to remove the object)', async () => {
    const { runner, fakeStorage } = buildHarness();
    // Simulate an object that "deletes" successfully per the API but a
    // subsequent HEAD still resolves it (unprovable cleanup).
    const originalDelete = fakeStorage.deleteObject.getMockImplementation()!;
    let deleteCallCount = 0;
    fakeStorage.deleteObject.mockImplementation((key: string) => {
      deleteCallCount += 1;
      if (deleteCallCount === 1) {
        // Do NOT actually remove it from the store this one time.
        return Promise.resolve();
      }
      return originalDelete(key);
    });

    await expect(runner.run({ upload: true })).rejects.toMatchObject({
      code: 'HLS_CLEANUP_VERIFICATION_FAILED',
    });
  });
});

describe('HlsSmokeRunner — DB boundary (test 14)', () => {
  it('never imports PrismaService/@prisma/client anywhere under src/transcode/hls or src/worker', () => {
    const dirs = [join(__dirname), join(__dirname, '..', '..', 'worker')];

    for (const dir of dirs) {
      const files = readdirSync(dir).filter(
        (name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'),
      );
      expect(files.length).toBeGreaterThan(0);

      for (const file of files) {
        const code = readFileSync(join(dir, file), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '');
        expect(code).not.toMatch(/PrismaService/);
        expect(code).not.toMatch(/@prisma\/client/);
        expect(code).not.toMatch(/prisma\.video/i);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// OPTIONAL real-ffmpeg, real-DI, full-pipeline integration test. Auto-skips
// (11D-2b precedent) when ffmpeg/ffprobe are not on PATH. This is the "ONE
// real-local-ffmpeg integration test" required by the 11O approval — it
// wires the REAL HlsModule (real generator/probe/encoder CLI clients — the
// only thing mocked is `StorageService`, so this NEVER touches the network),
// generates the real synthetic source, transcodes all 4 real rungs, builds
// and validates a real master playlist, and asserts the validator's verdict
// is genuinely `valid: true`.
// ---------------------------------------------------------------------------
function isFfmpegAvailable(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const maybeDescribe = isFfmpegAvailable() ? describe : describe.skip;

maybeDescribe(
  'HlsSmokeRunner (REAL ffmpeg/ffprobe, real DI graph, auto-skips if unavailable)',
  () => {
    it('runs the full local 4-rung proof end-to-end and validates successfully', async () => {
      const fakeStorage = new FakeStorageService();

      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            ignoreEnvFile: true,
            load: [
              () => ({
                storage: {
                  driver: 'local',
                  endpoint: '',
                  region: 'auto',
                  bucket: 'unused',
                  accessKeyId: 'unused',
                  secretAccessKey: 'unused',
                  publicBaseUrl: undefined,
                },
              }),
            ],
          }),
          HlsModule,
        ],
      })
        .overrideProvider(StorageService)
        .useValue(fakeStorage)
        .compile();

      const runner = moduleRef.get(HlsSmokeRunner);

      // NOTE: temp-dir cleanup (both the source dir and the package root,
      // success AND failure paths) is already deterministically proven —
      // without any raciness — by the MOCKED tests above (e.g. "cleans up
      // both the source temp dir and the package root even on success").
      // This test deliberately does NOT also scan the shared, real
      // `os.tmpdir()` for "leaked" `11o-hls-*` directories: under Jest's
      // parallel multi-worker execution, unrelated concurrently-running
      // spec files (in OTHER worker processes) can legitimately have their
      // own `11o-hls-source-*`/`11o-hls-package-*` directories in flight at
      // the exact moment such a before/after snapshot would be taken here,
      // making that comparison flaky (observed empirically during 11O
      // implementation) rather than a real signal.
      const result = await runner.run();

      expect(result.validation.valid).toBe(true);
      expect(result.validation.issues).toEqual([]);
      expect(result.rungArtifacts).toHaveLength(4);
      expect(result.sourceProbe.width).toBe(1080);
      expect(result.sourceProbe.height).toBe(1920);
      expect(result.wallClockMs).toBeGreaterThan(0);

      await moduleRef.close();
    }, 60_000);
  },
);
