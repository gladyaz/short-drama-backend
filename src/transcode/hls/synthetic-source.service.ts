import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AppErrorCode } from '../../common/errors/app-error-code';
import { AppException } from '../../common/errors/app.exception';
import { redactSensitiveText } from '../../common/logging/redact';
import {
  HLS_SOURCE_TEMP_DIR_PREFIX,
  SYNTHETIC_SOURCE_AUDIO_FREQUENCY_HZ,
  SYNTHETIC_SOURCE_DURATION_SECONDS,
  SYNTHETIC_SOURCE_FPS,
  SYNTHETIC_SOURCE_HEIGHT_PX,
  SYNTHETIC_SOURCE_MAX_DURATION_SECONDS,
  SYNTHETIC_SOURCE_MIN_DURATION_SECONDS,
  SYNTHETIC_SOURCE_WIDTH_PX,
} from './hls.constants';
import { HLS_PROBE_CLIENT, HLS_SYNTHETIC_GENERATOR_CLIENT } from './hls.types';
import type {
  HlsProbeClient,
  HlsSourceProbe,
  HlsSyntheticGeneratorClient,
} from './hls.types';

const SYNTHETIC_SOURCE_FILENAME = 'source.mp4';

export interface SyntheticSourceResult {
  /** The `fs.mkdtemp` directory this source lives in — caller owns removing it. */
  tempDir: string;
  sourcePath: string;
  probe: HlsSourceProbe;
}

/**
 * Slice 11O — generates ONE ~6 s 1080×1920 portrait synthetic MP4 (video +
 * audio, both `ffmpeg lavfi`-generated) inside a fresh `fs.mkdtemp`
 * directory, then ffprobe-validates it BEFORE returning it to a caller —
 * approval binding constraint 3 ("Source: ONE synthetic 1080×1920 portrait
 * MP4, ~5–10 s, synthetic video + audio, ffprobe-validated, temp-dir only.
 * No company/user media.").
 *
 * Both the generator and the prober are injected DI abstractions
 * (`HlsSyntheticGeneratorClient`/`HlsProbeClient`) — every unit test in this
 * file mocks both, so no test here spawns a real `ffmpeg`/`ffprobe`
 * process; a separate, auto-skipping integration spec exercises the real
 * CLI clients end-to-end (11D-2b precedent).
 */
@Injectable()
export class SyntheticSourceService {
  private readonly logger = new Logger(SyntheticSourceService.name);

  constructor(
    @Inject(HLS_SYNTHETIC_GENERATOR_CLIENT)
    private readonly generatorClient: HlsSyntheticGeneratorClient,
    @Inject(HLS_PROBE_CLIENT)
    private readonly probeClient: HlsProbeClient,
  ) {}

  async generate(): Promise<SyntheticSourceResult> {
    const tempDir = await mkdtemp(join(tmpdir(), HLS_SOURCE_TEMP_DIR_PREFIX));
    const sourcePath = join(tempDir, SYNTHETIC_SOURCE_FILENAME);

    try {
      await this.generatorClient.generate({
        outputPath: sourcePath,
        widthPx: SYNTHETIC_SOURCE_WIDTH_PX,
        heightPx: SYNTHETIC_SOURCE_HEIGHT_PX,
        durationSeconds: SYNTHETIC_SOURCE_DURATION_SECONDS,
        fps: SYNTHETIC_SOURCE_FPS,
        audioFrequencyHz: SYNTHETIC_SOURCE_AUDIO_FREQUENCY_HZ,
      });

      const probe = await this.probeClient.probe(sourcePath);
      this.assertUsableFixture(probe);

      return { tempDir, sourcePath, probe };
    } catch (error) {
      // The temp dir is only ever populated by this call — if generation or
      // validation fails, nothing usable was returned to a caller, so this
      // method cleans up its own directory rather than leaking a stray temp
      // dir for every failed attempt.
      await rm(tempDir, { recursive: true, force: true });
      throw this.toAppException(error);
    }
  }

  private assertUsableFixture(probe: HlsSourceProbe): void {
    if (
      probe.width !== SYNTHETIC_SOURCE_WIDTH_PX ||
      probe.height !== SYNTHETIC_SOURCE_HEIGHT_PX
    ) {
      throw new AppException(
        AppErrorCode.HLS_SOURCE_GENERATION_FAILED,
        `Synthetic source has unexpected dimensions ${probe.width}x${probe.height}, expected ${SYNTHETIC_SOURCE_WIDTH_PX}x${SYNTHETIC_SOURCE_HEIGHT_PX}`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    if (
      probe.durationSeconds < SYNTHETIC_SOURCE_MIN_DURATION_SECONDS ||
      probe.durationSeconds > SYNTHETIC_SOURCE_MAX_DURATION_SECONDS
    ) {
      throw new AppException(
        AppErrorCode.HLS_SOURCE_GENERATION_FAILED,
        `Synthetic source duration ${probe.durationSeconds}s is outside the accepted window [${SYNTHETIC_SOURCE_MIN_DURATION_SECONDS}, ${SYNTHETIC_SOURCE_MAX_DURATION_SECONDS}]`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    if (!probe.hasAudio) {
      throw new AppException(
        AppErrorCode.HLS_SOURCE_GENERATION_FAILED,
        'Synthetic source has no audio stream, expected one',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }

  private toAppException(error: unknown): AppException {
    if (error instanceof AppException) {
      return error;
    }

    const detail =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    this.logger.warn(
      redactSensitiveText(`Synthetic source generation failed: ${detail}`),
    );

    return new AppException(
      AppErrorCode.HLS_SOURCE_GENERATION_FAILED,
      'Synthetic source generation failed',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
