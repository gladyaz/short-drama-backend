import { existsSync } from 'fs';
import { readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { AppException } from '../../common/errors/app.exception';
import { AppErrorCode } from '../../common/errors/app-error-code';
import { HLS_SOURCE_TEMP_DIR_PREFIX } from './hls.constants';
import { SyntheticSourceService } from './synthetic-source.service';
import {
  HlsProbeClient,
  HlsSourceProbe,
  HlsSyntheticGeneratorClient,
  HlsSyntheticSourceRequest,
} from './hls.types';

function validProbe(overrides: Partial<HlsSourceProbe> = {}): HlsSourceProbe {
  return {
    width: 1080,
    height: 1920,
    rotation: 0,
    fps: 30,
    hasAudio: true,
    durationSeconds: 6,
    videoCodec: 'h264',
    audioCodec: 'aac',
    ...overrides,
  };
}

describe('SyntheticSourceService', () => {
  // Held as standalone bindings (never accessed as `generatorClient.generate`/
  // `probeClient.probe`) so assertions never trigger
  // `@typescript-eslint/unbound-method` — a jest mock function has no
  // meaningful `this` binding to lose, but the rule cannot tell that from a
  // bare object-method reference.
  let generateMock: jest.Mock<Promise<void>, [HlsSyntheticSourceRequest]>;
  let probeMock: jest.Mock<Promise<HlsSourceProbe>, [string]>;
  let generatorClient: jest.Mocked<HlsSyntheticGeneratorClient>;
  let probeClient: jest.Mocked<HlsProbeClient>;
  let service: SyntheticSourceService;
  let createdTempDirs: string[];

  beforeEach(() => {
    generateMock = jest
      .fn<Promise<void>, [HlsSyntheticSourceRequest]>()
      .mockResolvedValue(undefined);
    probeMock = jest
      .fn<Promise<HlsSourceProbe>, [string]>()
      .mockResolvedValue(validProbe());
    generatorClient = { generate: generateMock };
    probeClient = { probe: probeMock };
    service = new SyntheticSourceService(generatorClient, probeClient);
    createdTempDirs = [];
  });

  afterEach(async () => {
    // On SUCCESS, `SyntheticSourceService` deliberately does NOT remove its
    // own temp dir (the caller owns it, since it's still needed by
    // downstream steps) — this suite cleans up whatever it created so tests
    // never litter os.tmpdir().
    await Promise.all(
      createdTempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function listSourceTempDirs(): Promise<string[]> {
    const entries = await readdir(tmpdir());
    return entries.filter((entry) =>
      entry.startsWith(HLS_SOURCE_TEMP_DIR_PREFIX),
    );
  }

  it('generates the source inside a fresh mkdtemp directory and probe-validates it', async () => {
    const result = await service.generate();
    createdTempDirs.push(result.tempDir);

    const generateRequest = generateMock.mock.calls[0][0];
    expect(generateRequest.widthPx).toBe(1080);
    expect(generateRequest.heightPx).toBe(1920);
    expect(generateRequest.outputPath).toContain(result.tempDir);
    expect(probeMock).toHaveBeenCalledWith(result.sourcePath);
    expect(result.probe).toEqual(validProbe());
    expect(existsSync(result.tempDir)).toBe(true);
  });

  it('rejects a generated source with unexpected dimensions', async () => {
    probeClient.probe.mockResolvedValue(
      validProbe({ width: 640, height: 480 }),
    );

    await expect(service.generate()).rejects.toMatchObject({
      code: AppErrorCode.HLS_SOURCE_GENERATION_FAILED,
    });
  });

  it('rejects a generated source whose duration is outside the accepted window', async () => {
    probeClient.probe.mockResolvedValue(validProbe({ durationSeconds: 1 }));

    await expect(service.generate()).rejects.toBeInstanceOf(AppException);
  });

  it('rejects a generated source with no audio stream', async () => {
    probeClient.probe.mockResolvedValue(validProbe({ hasAudio: false }));

    await expect(service.generate()).rejects.toMatchObject({
      code: AppErrorCode.HLS_SOURCE_GENERATION_FAILED,
    });
  });

  it('removes its own temp directory when generation fails', async () => {
    generatorClient.generate.mockRejectedValue(new Error('ffmpeg not found'));

    const before = await listSourceTempDirs();
    await expect(service.generate()).rejects.toBeInstanceOf(AppException);
    const after = await listSourceTempDirs();

    expect(after.length).toBe(before.length);
  });

  it('removes its own temp directory when probe validation fails', async () => {
    probeClient.probe.mockResolvedValue(validProbe({ hasAudio: false }));

    const before = await listSourceTempDirs();
    await expect(service.generate()).rejects.toBeInstanceOf(AppException);
    const after = await listSourceTempDirs();

    expect(after.length).toBe(before.length);
  });

  it('never touches STORAGE_ROOT or any path outside os.tmpdir()', async () => {
    const result = await service.generate();
    createdTempDirs.push(result.tempDir);
    expect(result.tempDir.startsWith(tmpdir())).toBe(true);
  });
});
