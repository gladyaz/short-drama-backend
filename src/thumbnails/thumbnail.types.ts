/**
 * Phase 11, work unit 11D-2a: a request to generate a single thumbnail frame
 * from a source video file.
 */
export interface ThumbnailGenerateRequest {
  /** Absolute path to the source video file on disk. Only ever read — never written to, moved, or deleted. */
  inputPath: string;
  /**
   * Absolute path the generated frame must be written to. The caller
   * (`ThumbnailService`) owns the containing directory — always a fresh
   * `fs.mkdtemp` temp directory, never `STORAGE_ROOT`.
   */
  outputPath: string;
  /** Offset into the source video, in seconds, to capture the frame at. */
  timestampSeconds: number;
  /** Target output width in pixels; height is derived proportionally by the real client. */
  width: number;
}

/**
 * The artifact a successful generation produced: the file that was written
 * and its measured pixel dimensions, so `ThumbnailService` can validate the
 * result against what was requested before ingesting it.
 */
export interface ThumbnailArtifact {
  outputPath: string;
  width: number;
  height: number;
}

/**
 * Injectable ffmpeg abstraction, mirroring `FfprobeClient`
 * (`../importer/importer.types.ts`). `ThumbnailsModule` provides the real
 * `FfmpegThumbnailCliClient` (shells out to the system `ffmpeg`/`ffprobe`
 * binaries) as the default implementation; every primary test in
 * `thumbnail.service.spec.ts` injects a mock/fixture implementation instead
 * via the `THUMBNAIL_CLIENT` token below — no primary test requires
 * `ffmpeg` to be installed, and none runs against a real media file. One
 * OPTIONAL integration test in that same file exercises the real client
 * end-to-end against a synthetic fixture and auto-skips when `ffmpeg` is
 * not on `PATH`.
 */
export interface ThumbnailClient {
  generate(request: ThumbnailGenerateRequest): Promise<ThumbnailArtifact>;
}

/** DI token for the injected `ThumbnailClient`. */
export const THUMBNAIL_CLIENT = 'THUMBNAILS_THUMBNAIL_CLIENT';

/**
 * Options a caller passes to `ThumbnailService.generate` — a source video
 * plus enough identity (`assetId`) to build a deterministic storage key,
 * with sensible generation defaults the caller may override.
 */
export interface GenerateThumbnailOptions {
  /** Absolute path to the source video file. Never written to, moved, or deleted. */
  inputPath: string;
  /**
   * Stable identity (e.g. a media/video id) the deterministic output key is
   * derived from — the same `assetId` + width variant always produces the
   * same key, so re-generating overwrites the same object instead of
   * accumulating orphans.
   */
  assetId: string;
  /** Overrides the default capture offset (seconds into the video). */
  timestampSeconds?: number;
  /** Overrides the default target output width in pixels. */
  width?: number;
}

/** Result of a successful generate-and-ingest call. */
export interface ThumbnailIngestResult {
  /** Deterministic object-storage key the thumbnail was ingested under. */
  key: string;
  width: number;
  height: number;
  contentType: string;
}
