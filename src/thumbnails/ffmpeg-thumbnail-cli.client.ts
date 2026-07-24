import { execFile } from 'child_process';
import { promisify } from 'util';
import { Injectable } from '@nestjs/common';
import {
  ThumbnailArtifact,
  ThumbnailClient,
  ThumbnailGenerateRequest,
} from './thumbnail.types';

const execFileAsync = promisify(execFile);

/**
 * Phase 11, work unit 11D-2a: the real, ffmpeg-backed implementation of
 * `ThumbnailClient` — shells out to the system `ffmpeg` binary to extract a
 * single frame at `timestampSeconds`, scaled to `width` (height derived
 * proportionally via `scale=width:-2`), then to `ffprobe` (mirroring
 * `../importer/ffprobe-cli.client.ts`) to measure the actual output
 * dimensions so the caller can validate the artifact. This is the ONLY
 * file in this work unit that requires `ffmpeg`/`ffprobe` to be installed,
 * and no primary unit test constructs or calls it: `ThumbnailsModule`
 * registers it as the default provider (for the future, human-supervised
 * real-bucket ingestion — see DECISIONS.md, work unit 11D-2-real, out of
 * scope here), but every primary test in `thumbnail.service.spec.ts`
 * injects a mock `ThumbnailClient` instead. One OPTIONAL integration test
 * in that same file exercises this class directly against a synthetic
 * fixture input, and auto-skips when `ffmpeg` is not on `PATH`.
 */
@Injectable()
export class FfmpegThumbnailCliClient implements ThumbnailClient {
  async generate(
    request: ThumbnailGenerateRequest,
  ): Promise<ThumbnailArtifact> {
    await execFileAsync('ffmpeg', [
      '-ss',
      String(request.timestampSeconds),
      '-i',
      request.inputPath,
      '-frames:v',
      '1',
      '-vf',
      `scale=${request.width}:-2`,
      '-y',
      request.outputPath,
    ]);

    const { width, height } = await this.probeDimensions(request.outputPath);

    return {
      outputPath: request.outputPath,
      width,
      height,
    };
  }

  private async probeDimensions(
    imagePath: string,
  ): Promise<{ width: number; height: number }> {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=s=x:p=0',
      imagePath,
    ]);

    const [widthPart, heightPart] = stdout.trim().split('x');
    const width = Number(widthPart);
    const height = Number(heightPart);

    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      throw new Error(
        'ffprobe returned no usable dimensions for the generated thumbnail',
      );
    }

    return { width, height };
  }
}
