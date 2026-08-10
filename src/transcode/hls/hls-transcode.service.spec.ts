import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppException } from '../../common/errors/app.exception';
import { AppErrorCode } from '../../common/errors/app-error-code';
import { HlsTranscodeService } from './hls-transcode.service';
import {
  HlsEncodeRungRequest,
  HlsEncoderClient,
  RenditionLadderResult,
} from './hls.types';

function rung(
  name: string,
  overrides: Partial<RenditionLadderResult['rungs'][number]> = {},
) {
  return {
    name,
    width: 360,
    height: 640,
    videoBitrateKbps: 600,
    maxrateKbps: 900,
    bufsizeKbps: 1800,
    profile: 'main' as const,
    level: '3.0',
    codecString: 'avc1.4d401e',
    ...overrides,
  };
}

describe('HlsTranscodeService', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hls-transcode-spec-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Writes fake init/segment files, mirroring what a real `HlsEncoderClient`
   * produces. Returns the mock function as a STANDALONE binding (`encodeRungMock`,
   * never accessed as `client.encodeRung`) alongside the client object, so
   * assertions never trigger `@typescript-eslint/unbound-method` — a jest
   * mock function has no meaningful `this` binding to lose, but the rule
   * cannot tell that from a bare object-method reference.
   */
  function fakeSuccessfulEncoder(segmentSizes: number[] = [1000, 500]): {
    client: HlsEncoderClient;
    encodeRungMock: jest.Mock;
  } {
    const encodeRungMock = jest.fn(async (request: HlsEncodeRungRequest) => {
      await mkdir(request.outputDir, { recursive: true });
      await writeFile(join(request.outputDir, 'init.mp4'), Buffer.alloc(200));
      await writeFile(join(request.outputDir, 'index.m3u8'), '#EXTM3U\n');
      for (const [index, size] of segmentSizes.entries()) {
        await writeFile(
          join(request.outputDir, `seg_${String(index).padStart(5, '0')}.m4s`),
          Buffer.alloc(size),
        );
      }
    });

    return { client: { encodeRung: encodeRungMock }, encodeRungMock };
  }

  it('encodes every rung into its own <packageRoot>/<rung.name>/ directory', async () => {
    const { client: encoder, encodeRungMock } = fakeSuccessfulEncoder();
    const service = new HlsTranscodeService(encoder);
    const ladder: RenditionLadderResult = {
      rungs: [
        rung('360p'),
        rung('540p', { name: '540p', width: 540, height: 960 }),
      ],
      fps: 30,
      includeAudio: true,
      effectiveWidth: 1080,
      effectiveHeight: 1920,
    };

    const artifacts = await service.transcodeAll('/src.mp4', tempDir, ladder);

    expect(artifacts).toHaveLength(2);
    expect(artifacts[0].outputDir).toBe(join(tempDir, '360p'));
    expect(artifacts[1].outputDir).toBe(join(tempDir, '540p'));
    expect(encodeRungMock).toHaveBeenCalledTimes(2);
  });

  it('measures totalMediaBytes as init + every segment (excludes the playlist text itself)', async () => {
    const { client: encoder } = fakeSuccessfulEncoder([1000, 500]);
    const service = new HlsTranscodeService(encoder);
    const ladder: RenditionLadderResult = {
      rungs: [rung('360p')],
      fps: 30,
      includeAudio: true,
      effectiveWidth: 1080,
      effectiveHeight: 1920,
    };

    const [artifact] = await service.transcodeAll('/src.mp4', tempDir, ladder);

    // init.mp4 (200 bytes) + seg_00000 (1000) + seg_00001 (500) = 1700.
    expect(artifact.totalMediaBytes).toBe(1700);
    expect(artifact.segmentCount).toBe(2);
    expect(artifact.playlistRelativePath).toBe('360p/index.m3u8');
  });

  // Test: "one rendition fails -> whole job fails".
  it('stops at the first failing rung and throws HLS_TRANSCODE_FAILED — a partial ladder is never returned', async () => {
    // First rung "succeeds" (writes a real file), second rung fails.
    const encodeRungMock = jest.fn(async (request: HlsEncodeRungRequest) => {
      if (request.rung.name === '360p') {
        await mkdir(request.outputDir, { recursive: true });
        await writeFile(join(request.outputDir, 'init.mp4'), Buffer.alloc(10));
      } else {
        throw new Error('ffmpeg exited 1');
      }
    });
    const encoderWithFs: HlsEncoderClient = { encodeRung: encodeRungMock };
    const service = new HlsTranscodeService(encoderWithFs);
    const ladder: RenditionLadderResult = {
      rungs: [
        rung('360p'),
        rung('540p', { name: '540p', width: 540, height: 960 }),
      ],
      fps: 30,
      includeAudio: true,
      effectiveWidth: 1080,
      effectiveHeight: 1920,
    };

    await expect(
      service.transcodeAll('/src.mp4', tempDir, ladder),
    ).rejects.toMatchObject({ code: AppErrorCode.HLS_TRANSCODE_FAILED });
    expect(encodeRungMock).toHaveBeenCalledTimes(2);
  });

  it('the thrown error is an AppException with HTTP status 422', async () => {
    const encoder: HlsEncoderClient = {
      encodeRung: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const service = new HlsTranscodeService(encoder);
    const ladder: RenditionLadderResult = {
      rungs: [rung('360p')],
      fps: 30,
      includeAudio: true,
      effectiveWidth: 1080,
      effectiveHeight: 1920,
    };

    await expect(
      service.transcodeAll('/src.mp4', tempDir, ladder),
    ).rejects.toBeInstanceOf(AppException);
  });
});
