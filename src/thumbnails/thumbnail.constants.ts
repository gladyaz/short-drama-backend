/**
 * Phase 11, work unit 11D-2b: generation defaults + shared constants for
 * `ThumbnailService`. Kept separate from `thumbnail.types.ts` so numeric/
 * string constants don't clutter the interface definitions, mirroring
 * `../storage/storage.constants.ts`'s split.
 */

/**
 * Default capture offset (seconds into the source video) used when the
 * caller does not override it. A fixed offset rather than a fraction of
 * duration, since duration is not always known up front by every caller.
 */
export const DEFAULT_THUMBNAIL_TIMESTAMP_SECONDS = 3;

/** Default target output width (pixels) used when the caller does not override it. */
export const DEFAULT_THUMBNAIL_WIDTH = 480;

/** Content type of every thumbnail this service generates and ingests. */
export const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

/** Video file extensions `ThumbnailService` accepts as a generation source. */
export const SUPPORTED_VIDEO_EXTENSIONS = [
  '.mp4',
  '.mov',
  '.mkv',
  '.webm',
  '.avi',
];

/**
 * Prefix for the `fs.mkdtemp` directory each `generate()` call creates
 * under `os.tmpdir()` — exported so tests can assert no directory with this
 * prefix survives after a call (success or failure).
 */
export const THUMBNAIL_TEMP_DIR_PREFIX = 'thumbnail-';
