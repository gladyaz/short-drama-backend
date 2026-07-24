import { execFile } from 'child_process';
import { promisify } from 'util';
import { Injectable } from '@nestjs/common';
import { FfprobeClient, FfprobeMetadata } from './importer.types';

const execFileAsync = promisify(execFile);

interface FfprobeJsonOutput {
  format?: { duration?: string };
  streams?: Array<{
    codec_type?: string;
    width?: number;
    height?: number;
  }>;
}

/**
 * Phase 11, work unit 11D-1: the real, ffprobe-backed implementation of
 * `FfprobeClient` — shells out to the system `ffprobe` binary. This is the
 * ONLY file in this work unit that would ever touch a real media file or
 * require `ffmpeg`/`ffprobe` to be installed, and no test in this
 * credential-free slice constructs or calls it: `ImporterModule` registers
 * it as the default provider (for the future, human-supervised 11D-1-real
 * run against the real company library — see DECISIONS.md), but every
 * test injects a mock/fixture `FfprobeClient` instead (see
 * `media-importer.service.spec.ts`).
 */
@Injectable()
export class FfprobeCliClient implements FfprobeClient {
  async probe(sourcePath: string): Promise<FfprobeMetadata> {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      sourcePath,
    ]);

    const parsed = JSON.parse(stdout) as FfprobeJsonOutput;
    const videoStream = parsed.streams?.find(
      (stream) => stream.codec_type === 'video',
    );

    if (!videoStream || !parsed.format?.duration) {
      throw new Error(
        `ffprobe returned no usable video stream for "${sourcePath}"`,
      );
    }

    return {
      durationSeconds: Math.round(Number(parsed.format.duration)),
      width: videoStream.width ?? 0,
      height: videoStream.height ?? 0,
    };
  }
}
