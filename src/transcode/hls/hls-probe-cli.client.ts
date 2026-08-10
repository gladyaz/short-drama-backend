import { execFile } from 'child_process';
import { promisify } from 'util';
import { Injectable } from '@nestjs/common';
import { HlsProbeClient, HlsSourceProbe } from './hls.types';

const execFileAsync = promisify(execFile);

/** Cap on buffered ffprobe stdout, mirroring `../../storage/storage-r2-media-smoke.helpers.ts`. */
const CHILD_PROCESS_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

interface FfprobeSideData {
  side_data_type?: string;
  rotation?: number;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
}

interface FfprobeFrame {
  side_data_list?: FfprobeSideData[];
}

interface FfprobeJsonOutput {
  format?: { duration?: string };
  streams?: FfprobeStream[];
  frames?: FfprobeFrame[];
}

/**
 * Slice 11O — the real, `ffprobe`-backed `HlsProbeClient` implementation.
 * This is the ONLY file in this slice that shells out to `ffprobe` for the
 * rich probe (dims/fps/rotation/audio/duration/codecs) the ladder function
 * and the package validator both depend on — every consuming service's unit
 * tests inject a mock `HlsProbeClient` instead (mirrors
 * `FfprobeCliClient`/`FfmpegThumbnailCliClient`'s precedent).
 *
 * ## Rotation side-data — empirical finding (11O implementation)
 *
 * Against the installed ffmpeg 8.1.2 build, `-metadata:s:v:0 rotate=90` at
 * encode time did NOT survive into the container in any ffprobe-visible
 * form (no stream tag, no stream-level side data) — this appears to be a
 * genuine behavior change from older ffmpeg versions that used to write the
 * `rotate` tag into the mov `tkhd` display matrix. The mechanism that DOES
 * work in this build is the `h264_metadata` bitstream filter's
 * `display_orientation`/`rotate` options, which insert a real H.264 Display
 * Orientation SEI message — and ffprobe reports THAT only at the FRAME
 * level (`-show_frames`), as a `side_data_list` entry with
 * `side_data_type: "3x3 displaymatrix"` and a numeric `rotation` field, not
 * as stream-level side data. This client therefore probes the FIRST video
 * frame's side data (`-read_intervals "%+#1"` bounds the frame output to
 * exactly one frame, verified empirically to leave `format.duration`/
 * `streams[]` fully populated for the whole file in the SAME call) and
 * looks for a `"3x3 displaymatrix"` entry there. `rotation` defaults to `0`
 * when no such entry is present (the overwhelmingly common case — including
 * every fixture this slice's tests actually exercise) or when it cannot be
 * parsed as a finite number, which is the safe default: `rendition-ladder.ts`
 * treats `0`/`180` identically for ladder purposes (no dimension swap).
 */
@Injectable()
export class HlsProbeCliClient implements HlsProbeClient {
  async probe(mediaPath: string): Promise<HlsSourceProbe> {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        '-show_frames',
        '-read_intervals',
        '%+#1',
        mediaPath,
      ],
      { maxBuffer: CHILD_PROCESS_MAX_BUFFER_BYTES },
    );

    const parsed = JSON.parse(stdout) as FfprobeJsonOutput;
    const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
    const audioStream = parsed.streams?.find((s) => s.codec_type === 'audio');
    const durationSeconds = Number(parsed.format?.duration);

    if (!videoStream || !Number.isFinite(durationSeconds)) {
      throw new Error(
        `ffprobe returned no usable video stream or duration for "${mediaPath}"`,
      );
    }

    return {
      width: videoStream.width ?? 0,
      height: videoStream.height ?? 0,
      rotation: extractRotation(parsed.frames),
      fps: parseFrameRate(
        videoStream.r_frame_rate ?? videoStream.avg_frame_rate,
      ),
      hasAudio: audioStream !== undefined,
      durationSeconds,
      videoCodec: videoStream.codec_name ?? 'unknown',
      audioCodec: audioStream?.codec_name,
    };
  }
}

function extractRotation(frames: FfprobeFrame[] | undefined): number {
  const sideData = frames?.[0]?.side_data_list?.find(
    (entry) => entry.side_data_type === '3x3 displaymatrix',
  );

  return Number.isFinite(sideData?.rotation)
    ? (sideData!.rotation as number)
    : 0;
}

/** `r_frame_rate` is a rational string like `"30/1"` or `"30000/1001"`. */
function parseFrameRate(value: string | undefined): number {
  if (!value) {
    return 0;
  }

  const [numerator, denominator] = value.split('/').map(Number);

  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  ) {
    return 0;
  }

  return numerator / denominator;
}
