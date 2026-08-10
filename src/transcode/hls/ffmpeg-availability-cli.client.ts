import { execFile } from 'child_process';
import { promisify } from 'util';
import { Injectable } from '@nestjs/common';
import { FfmpegAvailability, FfmpegAvailabilityClient } from './hls.types';

const execFileAsync = promisify(execFile);

/**
 * Slice 11O — the real, CLI-backed `FfmpegAvailabilityClient` implementation:
 * shells out to `ffmpeg -version`/`ffprobe -version` to report PRESENCE and a
 * non-secret version string. This is the ONLY file `WorkerReadinessService`
 * depends on for its boot-time log, and `WorkerReadinessService`'s own unit
 * tests inject a mock implementation instead — no test in this slice's
 * primary suite spawns a real process for this check (mirrors
 * `FfprobeCliClient`/`FfmpegThumbnailCliClient`'s precedent). Never throws:
 * a missing binary resolves to `available: false`, not a rejected promise —
 * this is a readiness SIGNAL, not a hard requirement for the worker process
 * itself to start.
 */
@Injectable()
export class FfmpegAvailabilityCliClient implements FfmpegAvailabilityClient {
  async check(): Promise<FfmpegAvailability> {
    const [ffmpegVersion, ffprobeVersion] = await Promise.all([
      this.detectVersion('ffmpeg'),
      this.detectVersion('ffprobe'),
    ]);

    return {
      ffmpegAvailable: ffmpegVersion !== undefined,
      ffprobeAvailable: ffprobeVersion !== undefined,
      ffmpegVersion,
      ffprobeVersion,
    };
  }

  private async detectVersion(
    binary: 'ffmpeg' | 'ffprobe',
  ): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync(binary, ['-version']);
      return parseVersionLine(stdout);
    } catch {
      return undefined;
    }
  }
}

/**
 * `ffmpeg -version`'s first line looks like `ffmpeg version 8.1.2 Copyright
 * ...` — extracts just the version token. Falls back to `undefined` (not a
 * thrown error) if the output does not match the expected shape, since a
 * non-standard build's version string is not worth failing readiness over.
 */
function parseVersionLine(stdout: string): string | undefined {
  const firstLine = stdout.split('\n')[0] ?? '';
  const match = /version\s+(\S+)/.exec(firstLine);
  return match?.[1];
}
