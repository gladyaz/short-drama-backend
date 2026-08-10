/**
 * Slice 11O — non-profile constants shared across the local HLS proof
 * pipeline. Split from `hls-profile.constants.ts` mirroring
 * `../../storage/storage.constants.ts`'s precedent (numeric/string
 * constants kept out of the rendition-table file).
 */

/** `fs.mkdtemp` prefix for the synthetic source's own temp directory. */
export const HLS_SOURCE_TEMP_DIR_PREFIX = '11o-hls-source-';

/** `fs.mkdtemp` prefix for the HLS package root (master + per-rung directories). */
export const HLS_PACKAGE_TEMP_DIR_PREFIX = '11o-hls-package-';

/** The one synthetic source this slice ever transcodes (approval binding constraint 3). */
export const SYNTHETIC_SOURCE_WIDTH_PX = 1080;
export const SYNTHETIC_SOURCE_HEIGHT_PX = 1920;
export const SYNTHETIC_SOURCE_DURATION_SECONDS = 6;
export const SYNTHETIC_SOURCE_FPS = 30;
export const SYNTHETIC_SOURCE_AUDIO_FREQUENCY_HZ = 440;

/** Accepted ffprobe duration window for the synthetic source (container duration is never exact to the microsecond). */
export const SYNTHETIC_SOURCE_MIN_DURATION_SECONDS = 5;
export const SYNTHETIC_SOURCE_MAX_DURATION_SECONDS = 7;

/**
 * Object-key prefix for every object the gated real-R2 spec ever creates —
 * mirrors the `_r2-media-smoke-tests/`/`_r2-smoke-tests/` convention
 * (11G-4/11K): unmistakably disposable, never a real media key shape.
 * Approval binding constraint 7: `_r2-hls-smoke-tests/<unique>/`.
 */
export const HLS_SMOKE_KEY_PREFIX = '_r2-hls-smoke-tests/';

/**
 * Content-Type values per RFC 8216 §4 ("Media Types" appendix): a Playlist
 * is `application/vnd.apple.mpegurl`; a fMP4 Media Initialization Section
 * (`init.mp4`) is `video/mp4`; a fMP4 Media Segment (`.m4s`) is the
 * dedicated `video/iso.segment` type — distinct from `video/mp4` even
 * though both are ISO-BMFF, because a bare media segment (no `ftyp`/`moov`)
 * is not independently a valid MP4 file the way an init segment or a full
 * progressive MP4 is.
 */
export const HLS_PLAYLIST_CONTENT_TYPE = 'application/vnd.apple.mpegurl';
export const HLS_INIT_SEGMENT_CONTENT_TYPE = 'video/mp4';
export const HLS_MEDIA_SEGMENT_CONTENT_TYPE = 'video/iso.segment';

export const HLS_MASTER_PLAYLIST_FILENAME = 'master.m3u8';
export const HLS_VARIANT_PLAYLIST_FILENAME = 'index.m3u8';
export const HLS_INIT_SEGMENT_FILENAME = 'init.mp4';

/** Acceptable drift between the produced package's total duration and the source's probed duration. */
export const HLS_DURATION_TOLERANCE_SECONDS = 4.5;
