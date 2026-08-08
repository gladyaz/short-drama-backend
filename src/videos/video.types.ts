export interface VideoRecord {
  id: string;
  seriesId: string;
  title: string;
  episodeNumber: number;
  channelName: string;
  caption: string;
  category: string;
  /** Path relative to STORAGE_ROOT. Never an absolute filesystem path. */
  storageKey: string;
  sourceLanguage: string;
  hasEmbeddedIndonesianSubtitle: boolean;
  likeCount: number;
  durationSeconds?: number;
  /** Pixel dimensions measured with ffprobe against the real source file. */
  width?: number;
  height?: number;
}

export interface VideoResponseDto {
  id: string;
  seriesId: string;
  title: string;
  episodeNumber: number;
  channelName: string;
  caption: string;
  category: string;
  storageKey: string;
  playbackUrl: string;
  thumbnailUrl?: string;
  sourceLanguage: string;
  hasEmbeddedIndonesianSubtitle: boolean;
  likeCount: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
}

/**
 * Phase 11, work unit 11M-B4: `GET /videos/:id/playback`'s response
 * contract (DECISIONS.md "Slice 11M approved..." entry). Deliberately EXACTLY
 * these three fields — no bucket name, endpoint host, account id, object
 * key, or any other storage-configuration detail is ever included, for
 * either storage kind, so the mobile client learns nothing about which
 * backend (R2 vs local) served a given video.
 */
export interface VideoPlaybackResponseDto {
  /**
   * R2-backed media: a short-lived presigned GET URL pointing directly at
   * R2. Local-backed media: the existing `GET /videos/:id/stream` URL.
   */
  playbackUrl: string;
  /**
   * ISO-8601 timestamp. For R2-backed media this is genuine: the presigned
   * URL literally stops working at this instant (R2 enforces it). For
   * local-backed media it is SYNTHETIC — `GET /videos/:id/stream` has no
   * expiry of its own; it re-checks `JwtAuthGuard` + the entitlement gate
   * on every single request, indefinitely, for as long as the caller's
   * access token stays valid (see `VideosController#streamVideo`).
   *
   * Reviewed and kept synthetic rather than "fixed" (independent review,
   * 2026-08-08): this field's contract is "how long this playback
   * *authorization decision* should be trusted without re-asking", not
   * "how long the underlying URL is technically capable of responding" —
   * and on that reading a synthetic `PLAYBACK_URL_EXPIRY_SECONDS` value is
   * correct, not a lie, for BOTH branches. It keeps the mobile client's
   * behavior uniform across storage kinds (re-fetch `/playback` after 15
   * minutes either way, never special-cased per kind, per this DTO's own
   * "one code path" goal), and re-fetching is cheap for the local branch
   * specifically — no signing, no R2 round trip, just a DB read — unlike
   * treating it as infinite (which would need its own, kind-specific
   * client rule) or as a real never-expiring value (which would overstate
   * what the field actually promises: the underlying `/stream` route can
   * still deny the very next request if the caller's entitlement was
   * revoked in between, expiry or not).
   */
  expiresAt: string;
  /**
   * `true` for local-backed media, which is still gated by
   * `JwtAuthGuard`/the entitlement check on every request to `/stream` —
   * the client must attach `Authorization: Bearer <accessToken>`.
   * `false` for R2-backed media: the presigned URL itself carries all the
   * authorization R2 needs: attaching an `Authorization` header alongside
   * it would break AWS SigV4 signing (see DECISIONS.md's Option B
   * rejection rationale).
   */
  requiresAuthHeader: boolean;
}
