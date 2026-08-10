import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AppErrorCode } from '../../common/errors/app-error-code';
import { AppException } from '../../common/errors/app.exception';
import { redactSensitiveText } from '../../common/logging/redact';
import { HLS_VARIANT_PLAYLIST_FILENAME } from './hls.constants';
import { HLS_ENCODER_CLIENT } from './hls.types';
import type {
  HlsEncoderClient,
  HlsRungArtifact,
  RenditionLadderResult,
} from './hls.types';

/**
 * Slice 11O — runs the injected `HlsEncoderClient` once per ladder rung,
 * each writing into its own independent `<packageRoot>/<rung.name>/`
 * directory (approval architecture §5), then measures the produced
 * artifacts on disk (total media bytes + segment count) for the master
 * playlist's AVERAGE-BANDWIDTH computation and the package validator's
 * segment-count sanity check.
 *
 * **One rendition fails ⇒ the whole job fails** (2026-08-10 approval, §14
 * failure-behavior table: "a partial ladder breaks the ABR contract;
 * nothing flips") — the first rung to throw stops the loop immediately;
 * whatever rungs already succeeded are left on disk for
 * `HlsSmokeRunner`'s `finally`-block cleanup to remove, never uploaded.
 *
 * Every unit test in this file injects a mock `HlsEncoderClient` — no test
 * here spawns a real `ffmpeg` process.
 */
@Injectable()
export class HlsTranscodeService {
  private readonly logger = new Logger(HlsTranscodeService.name);

  constructor(
    @Inject(HLS_ENCODER_CLIENT)
    private readonly encoderClient: HlsEncoderClient,
  ) {}

  async transcodeAll(
    sourcePath: string,
    packageRoot: string,
    ladder: RenditionLadderResult,
  ): Promise<HlsRungArtifact[]> {
    const artifacts: HlsRungArtifact[] = [];

    for (const rung of ladder.rungs) {
      const outputDir = join(packageRoot, rung.name);

      try {
        await this.encoderClient.encodeRung({
          sourcePath,
          outputDir,
          rung,
          fps: ladder.fps,
          includeAudio: ladder.includeAudio,
        });
      } catch (error) {
        const detail =
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error);
        this.logger.warn(
          redactSensitiveText(
            `HLS transcode failed for rung "${rung.name}": ${detail}`,
          ),
        );

        throw new AppException(
          AppErrorCode.HLS_TRANSCODE_FAILED,
          `HLS transcode failed for rung "${rung.name}" — the whole job fails (no partial ladder is ever packaged)`,
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      artifacts.push(await this.measureArtifact(rung, outputDir));
    }

    return artifacts;
  }

  private async measureArtifact(
    rung: HlsRungArtifact['rung'],
    outputDir: string,
  ): Promise<HlsRungArtifact> {
    const entries = await readdir(outputDir);
    let totalMediaBytes = 0;
    let segmentCount = 0;

    for (const entry of entries) {
      const stats = await stat(join(outputDir, entry));

      if (entry.endsWith('.m4s')) {
        totalMediaBytes += stats.size;
        segmentCount += 1;
      } else if (entry === 'init.mp4') {
        totalMediaBytes += stats.size;
      }
    }

    return {
      rung,
      outputDir,
      playlistRelativePath: `${rung.name}/${HLS_VARIANT_PLAYLIST_FILENAME}`,
      totalMediaBytes,
      segmentCount,
    };
  }
}
