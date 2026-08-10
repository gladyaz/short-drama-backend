/**
 * Slice 11N — HLS Processing Data Model + Queue Foundation. Secret-free
 * transcode-readiness payload for `/health/details`, mirroring
 * `StorageReadinessResponse`'s exact shape/spirit (booleans + presence only
 * — never `REDIS_URL`'s value, a credential, or a host/port).
 */
export interface TranscodeReadinessResponse {
  /** The active `TRANSCODE_ENABLED` value. Not a secret. */
  enabled: boolean;
  /**
   * Only present when `enabled` is `true`. Whether `REDIS_URL` is
   * configured (name-presence only, never the value) — mirrors
   * `StorageReadinessResponse.configPresent`'s `r2` definition.
   */
  configPresent?: boolean;
  /**
   * Only present when `enabled` is `true`. Always equal to `configPresent`
   * today — this endpoint never opens a live Redis connection (see
   * `TranscodeReadinessService`'s class doc for why, mirroring
   * `StorageReadinessService`'s `r2` mode never probing R2 live).
   */
  ready?: boolean;
}
