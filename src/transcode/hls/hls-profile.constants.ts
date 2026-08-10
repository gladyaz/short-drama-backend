import { RungProfile } from './hls.types';

/**
 * Slice 11O. The frozen rendition table (proposal §3, 2026-08-10 approval
 * binding constraint 5), ascending by nominal short side. Values verified
 * empirically against the installed ffmpeg 8.1.2 / libx264 build during this
 * slice's implementation (see `rendition-ladder.spec.ts` and the report's
 * "ffmpeg command templates" section for the exact commands run and their
 * `ffprobe`-confirmed profile/level/dimension output).
 */
export const RUNG_PROFILES: readonly RungProfile[] = [
  {
    name: '360p',
    shortSide: 360,
    videoBitrateKbps: 600,
    maxrateKbps: 900,
    bufsizeKbps: 1800,
    profile: 'main',
    level: '3.0',
    codecString: 'avc1.4d401e',
  },
  {
    name: '540p',
    shortSide: 540,
    videoBitrateKbps: 1200,
    maxrateKbps: 1800,
    bufsizeKbps: 3600,
    profile: 'main',
    level: '3.1',
    codecString: 'avc1.4d401f',
  },
  {
    name: '720p',
    shortSide: 720,
    videoBitrateKbps: 2200,
    maxrateKbps: 3300,
    bufsizeKbps: 6600,
    profile: 'high',
    level: '3.1',
    codecString: 'avc1.64001f',
  },
  {
    name: '1080p',
    shortSide: 1080,
    videoBitrateKbps: 4000,
    maxrateKbps: 6000,
    bufsizeKbps: 12000,
    profile: 'high',
    level: '4.0',
    codecString: 'avc1.640028',
  },
];

/** fps is preserved up to this cap; never upconverted (proposal §3). */
export const MAX_OUTPUT_FPS = 30;

/** Segment target duration in seconds (proposal §3: "Segments 4 s"). */
export const HLS_SEGMENT_SECONDS = 4;

/** GOP length in seconds — keyframes every 2 s, segment-aligned (proposal §3). */
export const HLS_GOP_SECONDS = 2;

/** Capped-CRF value (proposal §3: "-crf 23 ... better quality-per-bit than fixed ABR"). */
export const HLS_CRF = 23;

/**
 * `-preset fast`, per the frozen architecture. Empirically benchmarked
 * during this slice: all 4 rungs of a 6 s 1080×1920 synthetic source encoded
 * in ~4 s wall-clock combined on this Mac (8 logical CPUs) — comfortably
 * fast enough that `veryfast` was not needed (see the report's "local
 * full-proof result" section for the actual measured run).
 */
export const HLS_PRESET = 'fast';

/** Audio: AAC-LC 96 kbps, 48 kHz, stereo — identical across every rung that has audio (proposal §3). */
export const HLS_AUDIO_CODEC_STRING = 'mp4a.40.2';
export const HLS_AUDIO_BITRATE_KBPS = 96;
export const HLS_AUDIO_SAMPLE_RATE_HZ = 48000;
export const HLS_AUDIO_CHANNELS = 2;
