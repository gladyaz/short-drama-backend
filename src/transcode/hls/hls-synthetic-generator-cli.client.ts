import { execFile } from 'child_process';
import { promisify } from 'util';
import { Injectable } from '@nestjs/common';
import {
  HlsSyntheticGeneratorClient,
  HlsSyntheticSourceRequest,
} from './hls.types';

const execFileAsync = promisify(execFile);

const CHILD_PROCESS_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * Slice 11O — the real, `ffmpeg`-backed `HlsSyntheticGeneratorClient`
 * implementation. Generates ONE fully synthetic portrait MP4 (`testsrc2`
 * video + `sine` audio, both produced by ffmpeg's `lavfi` virtual input
 * device from nothing but the arguments below — no file on disk is ever
 * read as an input, and no company/user media is ever touched).
 *
 * This REUSES THE TECHNIQUE of
 * `../../storage/storage-r2-media-smoke.helpers.ts::generateSyntheticMp4`
 * (11K) but is a fresh implementation, not an import from that file: that
 * module's own doc comment states it is test-only infrastructure ("NOTHING
 * in production code imports this module") sized for a tiny 64×64 2 s
 * fixture, whereas this slice needs a real ~6 s 1080×1920 portrait clip.
 * `SyntheticSourceService`'s unit tests inject a mock
 * `HlsSyntheticGeneratorClient` instead of constructing this class — no
 * primary test in this slice spawns a real `ffmpeg` process.
 */
@Injectable()
export class HlsSyntheticGeneratorCliClient implements HlsSyntheticGeneratorClient {
  async generate(request: HlsSyntheticSourceRequest): Promise<void> {
    await execFileAsync(
      'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=duration=${request.durationSeconds}:size=${request.widthPx}x${request.heightPx}:rate=${request.fps}`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=${request.audioFrequencyHz}:duration=${request.durationSeconds}`,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        '-movflags',
        '+faststart',
        '-y',
        request.outputPath,
      ],
      { maxBuffer: CHILD_PROCESS_MAX_BUFFER_BYTES },
    );
  }
}
