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
