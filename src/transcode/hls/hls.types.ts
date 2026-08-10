/**
 * Slice 11O — FFmpeg/HLS Worker Proof on ONE Synthetic Video (control
 * workspace `DECISIONS.md`, "2026-08-10 — Slice 11O APPROVED..."; architecture
 * `proposals/phase-11-hls-pipeline-proposal.md` §3–§5).
 *
 * Shared data shapes for the local (never-touches-R2-by-default) HLS proof
 * pipeline: probe → ladder → transcode → master playlist → validate →
 * (gated-only) upload/verify/cleanup. This module never reads or writes a
 * `Video`/catalog row and never imports `PrismaService` — the pipeline
 * operates on a local file path only (approval binding constraint: "DB
 * boundary ... must NOT read or write ANY Video/catalog row").
 */

/**
 * The subset of `ffprobe` output this slice's ladder math and packaging
 * depend on. Deliberately richer than `../../importer/importer.types.ts`'s
 * `FfprobeMetadata` (duration/width/height only) — this pipeline additionally
 * needs frame rate, audio presence, and rotation side-data, all applied
 * BEFORE ladder selection (proposal §4).
 */
export interface HlsSourceProbe {
  /** Coded (pre-rotation) pixel width, exactly as decoded. */
  width: number;
  /** Coded (pre-rotation) pixel height, exactly as decoded. */
  height: number;
  /**
   * Display-orientation rotation in degrees, counter-clockwise, as reported
   * by ffprobe's frame-level `side_data_list` (`"3x3 displaymatrix"` /
   * `rotation` field — verified empirically against the installed ffmpeg
   * 8.1.2 build via an H.264 `display_orientation` SEI fixture; see
   * `hls-probe-cli.client.ts`'s doc comment for the exact command and the
   * finding that this side data is reported per-FRAME, not per-stream, in
   * this build). `0` when no rotation side-data is present. Only `90` and
   * `270` (or their negative/counter-clockwise equivalents) swap the
   * effective width/height for ladder purposes; `180` does not.
   */
  rotation: number;
  /** Source frame rate (frames per second), as a real number (e.g. `29.97`). */
  fps: number;
  hasAudio: boolean;
  durationSeconds: number;
  videoCodec: string;
  audioCodec?: string;
}

/** The four fixed, catalog-frozen H.264 profile/level/codec combinations (proposal §3). */
export type H264Profile = 'main' | 'high';

/**
 * One row of the frozen rendition table (proposal §3): nominal short-side
 * pixel count plus its fixed bitrate/profile/level/codec-string values.
 * `name` is a fixed tier label for the four standard tiers; the degenerate
 * sub-360p case (see `rendition-ladder.ts`) synthesizes its own `${n}p` name
 * at runtime, so `RenditionLadderRung.name` below is `string`, not a union.
 */
export interface RungProfile {
  name: '360p' | '540p' | '720p' | '1080p';
  /** Nominal short-side pixel count this tier targets (360/540/720/1080). */
  shortSide: number;
  videoBitrateKbps: number;
  maxrateKbps: number;
  bufsizeKbps: number;
  profile: H264Profile;
  /** e.g. `"3.0"`, `"4.0"` — passed to ffmpeg's `-level` verbatim. */
  level: string;
  /** e.g. `"avc1.640028"` — the exact `CODECS` token for this rung. */
  codecString: string;
}

/** A single rendition ladder rung, resolved to CONCRETE output dimensions for one specific source. */
export interface RenditionLadderRung {
  name: string;
  width: number;
  height: number;
  videoBitrateKbps: number;
  maxrateKbps: number;
  bufsizeKbps: number;
  profile: H264Profile;
  level: string;
  codecString: string;
}

/** The full, pure result of laddering one source probe. */
export interface RenditionLadderResult {
  rungs: RenditionLadderRung[];
  /** Output frame rate: `min(source fps, 30)`, never upconverted. */
  fps: number;
  includeAudio: boolean;
  /** Post-rotation effective width used for ladder math. */
  effectiveWidth: number;
  /** Post-rotation effective height used for ladder math. */
  effectiveHeight: number;
}

/**
 * Injectable ffmpeg/ffprobe PRESENCE check, mirroring the
 * `FfprobeClient`/`ThumbnailClient` DI-token precedent
 * (`../../importer/importer.types.ts`, `../../thumbnails/thumbnail.types.ts`)
 * so `WorkerReadinessService`'s unit tests never spawn a real process. Used
 * ONLY by the worker's boot-time readiness log — never by the transcode
 * pipeline itself, which fails loudly on its own if the binary is missing.
 */
export interface FfmpegAvailabilityClient {
  check(): Promise<FfmpegAvailability>;
}

export interface FfmpegAvailability {
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  /** Non-secret version strings (e.g. `"8.1.2"`), when detected. */
  ffmpegVersion?: string;
  ffprobeVersion?: string;
}

/** DI token for the injected `FfmpegAvailabilityClient`. */
export const FFMPEG_AVAILABILITY_CLIENT = 'HLS_FFMPEG_AVAILABILITY_CLIENT';

/**
 * Injectable rich-probe abstraction (dims/fps/rotation/audio/duration/
 * codecs) — the real implementation shells out to `ffprobe`;
 * `HlsPackageValidator` and `SyntheticSourceService` both depend on this
 * interface, never on the CLI client concretely, so every primary unit test
 * in this slice mocks it and never spawns a real process.
 */
export interface HlsProbeClient {
  probe(mediaPath: string): Promise<HlsSourceProbe>;
}

/** DI token for the injected `HlsProbeClient`. */
export const HLS_PROBE_CLIENT = 'HLS_PROBE_CLIENT';

/** A request to synthesize the one disposable portrait MP4 this slice ever transcodes. */
export interface HlsSyntheticSourceRequest {
  /** Absolute output path (inside a caller-owned `fs.mkdtemp` directory). */
  outputPath: string;
  widthPx: number;
  heightPx: number;
  durationSeconds: number;
  fps: number;
  audioFrequencyHz: number;
}

/**
 * Injectable synthetic-source generator, mirroring the 11K
 * (`../../storage/storage-r2-media-smoke.helpers.ts::generateSyntheticMp4`)
 * TECHNIQUE (an `ffmpeg -f lavfi` `testsrc2`+`sine` clip, no company/user
 * media ever read) — reimplemented here, deliberately NOT imported from that
 * file, since its own doc comment states it is test-only infrastructure that
 * nothing in production code may import. This interface is the DI seam that
 * keeps `SyntheticSourceService`'s unit tests from ever spawning `ffmpeg`.
 */
export interface HlsSyntheticGeneratorClient {
  generate(request: HlsSyntheticSourceRequest): Promise<void>;
}

/** DI token for the injected `HlsSyntheticGeneratorClient`. */
export const HLS_SYNTHETIC_GENERATOR_CLIENT = 'HLS_SYNTHETIC_GENERATOR_CLIENT';

/** One rung's fully-resolved encode+package request. */
export interface HlsEncodeRungRequest {
  sourcePath: string;
  /** Directory this rung's `init.mp4`/`index.m3u8`/`seg_*.m4s` are written into. Always `<packageRoot>/<rung.name>/`. */
  outputDir: string;
  rung: RenditionLadderRung;
  /** Output frame rate (already capped at 30 by the ladder function). */
  fps: number;
  includeAudio: boolean;
}

/**
 * Injectable per-rung ffmpeg encoder abstraction — the real implementation
 * is the ONLY file in this slice that shells out to `ffmpeg` for the actual
 * transcode+HLS-package step. `HlsTranscodeService`'s unit tests inject a
 * mock instead.
 */
export interface HlsEncoderClient {
  encodeRung(request: HlsEncodeRungRequest): Promise<void>;
}

/** DI token for the injected `HlsEncoderClient`. */
export const HLS_ENCODER_CLIENT = 'HLS_ENCODER_CLIENT';

/** One produced rung's on-disk artifact summary, after a successful encode. */
export interface HlsRungArtifact {
  rung: RenditionLadderRung;
  outputDir: string;
  /** Relative-to-`packageRoot` path to this rung's variant playlist, e.g. `"360p/index.m3u8"`. */
  playlistRelativePath: string;
  /** Total bytes across `init.mp4` + every `seg_*.m4s` (excludes the `.m3u8` text itself) — the basis for AVERAGE-BANDWIDTH. */
  totalMediaBytes: number;
  segmentCount: number;
}

export interface HlsPackageValidationIssue {
  code: string;
  message: string;
}

export interface HlsPackageValidationResult {
  valid: boolean;
  issues: HlsPackageValidationIssue[];
}

/** One object this pipeline uploaded to R2 during the gated real-network run — tracked so cleanup deletes ONLY these. */
export interface HlsUploadedObject {
  key: string;
  contentType: string;
  sizeBytes: number;
}

export interface HlsSmokeRunOptions {
  /**
   * When `true`, additionally uploads the validated local package to R2
   * under a fresh unique `_r2-hls-smoke-tests/<uuid>/` prefix, verifies
   * every object, and cleans up — ONLY ever set by the gated real-R2 spec.
   * Every offline test and the local full-proof script use the default
   * `false`.
   */
  upload?: boolean;
}

export interface HlsSmokeRunResult {
  sourcePath: string;
  sourceProbe: HlsSourceProbe;
  ladder: RenditionLadderResult;
  packageRoot: string;
  masterPlaylistPath: string;
  masterPlaylistText: string;
  rungArtifacts: HlsRungArtifact[];
  validation: HlsPackageValidationResult;
  /** Total bytes across every produced local artifact (master + all rungs' media + variant playlists). */
  totalLocalBytes: number;
  totalLocalFileCount: number;
  wallClockMs: number;
  /** Present only when `options.upload` was `true`. */
  upload?: {
    keyPrefix: string;
    uploadedObjects: HlsUploadedObject[];
    verified: boolean;
    cleanedUp: boolean;
    cleanupIssues: string[];
  };
}
