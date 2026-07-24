/**
 * Phase 11, work unit 11D-1-dryrun: constants for `MediaDryRunService`.
 * Kept as its own small list (rather than importing `thumbnails/thumbnail
 * .constants.ts`'s `SUPPORTED_VIDEO_EXTENSIONS`) so the importer module
 * stays structurally independent of the thumbnails module — the two
 * happen to agree today, but nothing in this file requires them to.
 */

/** Video file extensions `MediaDryRunService` discovers/reports on. */
export const SUPPORTED_DRYRUN_VIDEO_EXTENSIONS = [
  '.mp4',
  '.mov',
  '.mkv',
  '.webm',
  '.avi',
];

/**
 * Max ffprobe attempts per discovered file before it is reported as
 * `probe_failed`, mirroring `MediaImporterService`'s `DEFAULT_MAX_ATTEMPTS`.
 */
export const DEFAULT_DRYRUN_MAX_ATTEMPTS = 3;
