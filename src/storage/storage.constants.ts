/**
 * Phase 11, work unit 11A-1. DI token for the injected S3-compatible client
 * (`StorageModule` provides a real `S3Client`; tests inject a mocked
 * `S3CompatibleClient` in its place — see `storage.types.ts`).
 */
export const S3_CLIENT = 'STORAGE_S3_CLIENT';

/** Default presigned PUT (upload) URL lifetime: 15 minutes. */
export const DEFAULT_PUT_URL_EXPIRY_SECONDS = 15 * 60;

/** Default presigned GET (download/playback) URL lifetime: 1 hour. */
export const DEFAULT_GET_URL_EXPIRY_SECONDS = 60 * 60;

/**
 * Phase 11, work unit 11M-B3: dedicated presigned GET URL lifetime for
 * `GET /videos/:id/playback`'s R2-backed branch — deliberately its OWN
 * constant, never `DEFAULT_GET_URL_EXPIRY_SECONDS` (1 hour). 15 minutes is
 * long enough to outlive a single episode's viewing, including a pause
 * (short-drama episodes run a few minutes each, matching mobile's existing
 * `FREE_EPISODE_LIMIT`-gated single-episode playback flow), while keeping a
 * leaked/shared URL short-lived. `VideosService.getPlaybackUrl` is the only
 * caller; it never persists the resulting URL anywhere.
 */
export const PLAYBACK_URL_EXPIRY_SECONDS = 15 * 60;

/**
 * Slice 11P: default `maxKeys` bound for
 * `StorageService.listObjectKeysByPrefix` — one HLS generation produces on
 * the order of tens of objects (4 rungs × a handful of segments each + one
 * master playlist), so 1000 comfortably covers a single generation's full
 * listing in one page while still being a real bound, not "unlimited".
 */
export const DEFAULT_LIST_MAX_KEYS = 1000;
