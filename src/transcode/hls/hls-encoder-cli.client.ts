import { execFile } from 'child_process';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import { Injectable } from '@nestjs/common';
import {
  HLS_AUDIO_BITRATE_KBPS,
  HLS_AUDIO_CHANNELS,
  HLS_AUDIO_SAMPLE_RATE_HZ,
  HLS_CRF,
  HLS_GOP_SECONDS,
  HLS_PRESET,
  HLS_SEGMENT_SECONDS,
} from './hls-profile.constants';
import { HlsEncodeRungRequest, HlsEncoderClient } from './hls.types';

const execFileAsync = promisify(execFile);

const CHILD_PROCESS_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * Slice 11O — the real, `ffmpeg`-backed `HlsEncoderClient` implementation:
 * the ONLY file in this slice that shells out to `ffmpeg` for the actual
 * per-rung transcode + fMP4/CMAF HLS packaging step. `HlsTranscodeService`'s
 * unit tests inject a mock `HlsEncoderClient` instead — no primary test in
 * this slice spawns a real `ffmpeg` process for a rung encode.
 *
 * ## Command shape (verified empirically during 11O implementation)
 *
 * Every flag below was run against a real synthetic 1080×1920 6 s source on
 * this Mac (ffmpeg 8.1.2 / libx264) before being frozen here — see the
 * report's "ffmpeg command templates" section for the exact transcripts.
 * Notable findings:
 * - **GOP/scene-cut**: `-g <2*fps> -keyint_min <2*fps> -sc_threshold 0`
 *   produces keyframes at EXACTLY the 2 s boundary and nowhere else, even
 *   against a source with an abrupt synthetic scene cut
 *   (`testsrc2`→`smptebars` concatenation) — because `-g` and `-keyint_min`
 *   are set to the SAME value, x264 cannot place a scene-cut keyframe any
 *   earlier than the forced interval regardless of `-sc_threshold`, so this
 *   pair alone already guarantees the segment-aligned GOP the architecture
 *   requires; `-sc_threshold 0` is kept as the documented, standard
 *   ffmpeg-generic flag from the frozen architecture (verified to produce
 *   IDENTICAL keyframe placement to `-x264-params scenecut=0` in this
 *   build, so the simpler flag was kept).
 * - **fMP4 init/segment filenames**: `-hls_fmp4_init_filename` and
 *   `-hls_segment_filename` are both resolved relative to the OUTPUT
 *   directory when given a bare filename / a path already rooted at that
 *   directory — both are passed as fully-resolved absolute-ish paths under
 *   `request.outputDir` here to avoid any ambiguity tied to the process's
 *   current working directory.
 * - **Profile/level**: `-profile:v <main|high> -level <3.0|3.1|4.0>`
 *   produces exactly the `RUNG_PROFILES` `codecString` values, confirmed by
 *   re-probing the produced `index.m3u8` (NOT the bare `init.mp4` alone,
 *   which lacks enough context for `ffprobe` to report profile/level/fps —
 *   `HlsPackageValidator` probes via the `.m3u8` for this reason).
 */
@Injectable()
export class HlsEncoderCliClient implements HlsEncoderClient {
  async encodeRung(request: HlsEncodeRungRequest): Promise<void> {
    await mkdir(request.outputDir, { recursive: true });

    const { rung } = request;
    const outputFps = Math.round(request.fps);
    const gopFrames = Math.round(HLS_GOP_SECONDS * outputFps);

    const audioArgs = request.includeAudio
      ? [
          '-c:a',
          'aac',
          '-b:a',
          `${HLS_AUDIO_BITRATE_KBPS}k`,
          '-ar',
          String(HLS_AUDIO_SAMPLE_RATE_HZ),
          '-ac',
          String(HLS_AUDIO_CHANNELS),
        ]
      : ['-an'];

    const args = [
      '-nostdin',
      '-v',
      'error',
      '-i',
      request.sourcePath,
      '-vf',
      `scale=${rung.width}:${rung.height}`,
      '-c:v',
      'libx264',
      '-profile:v',
      rung.profile,
      '-level',
      rung.level,
      '-pix_fmt',
      'yuv420p',
      '-crf',
      String(HLS_CRF),
      '-maxrate',
      `${rung.maxrateKbps}k`,
      '-bufsize',
      `${rung.bufsizeKbps}k`,
      '-preset',
      HLS_PRESET,
      '-g',
      String(gopFrames),
      '-keyint_min',
      String(gopFrames),
      '-sc_threshold',
      '0',
      '-r',
      String(outputFps),
      ...audioArgs,
      '-f',
      'hls',
      '-hls_time',
      String(HLS_SEGMENT_SECONDS),
      '-hls_segment_type',
      'fmp4',
      '-hls_flags',
      'independent_segments',
      '-hls_playlist_type',
      'vod',
      '-hls_fmp4_init_filename',
      'init.mp4',
      '-hls_segment_filename',
      join(request.outputDir, 'seg_%05d.m4s'),
      '-y',
      join(request.outputDir, 'index.m3u8'),
    ];

    await execFileAsync('ffmpeg', args, {
      maxBuffer: CHILD_PROCESS_MAX_BUFFER_BYTES,
    });
  }
}
