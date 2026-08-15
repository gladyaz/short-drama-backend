import { VideoContentKind } from './video-content-kind.types';

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
  /**
   * Explicit catalog classification - `drama` for real user-facing content,
   * `qa_fixture` for internal technical fixtures kept in the catalog on
   * purpose. Persisted on `Video.contentKind`; never inferred from title,
   * channel, language, storage key or dimensions. Required rather than
   * optional so every construction site has to declare it.
   */
  contentKind: VideoContentKind;
  /**
   * Work unit "Episode Access-Tier + Category Contract Hardening": the raw
   * `Video.accessTierOverride` column value, carried on the internal record
   * ONLY so `toVideoResponseDto` can resolve the public `accessTier` field
   * from it (via `resolveAccessTier`) — never copied onto `VideoResponseDto`
   * itself (see that DTO's `accessTier` field doc comment for why). Optional
   * because `src/videos/videos.data.ts`'s hardcoded seed-source array (also
   * typed `VideoRecord[]`) predates this column and never sets it; every
   * REAL construction site (`toVideoRecord`, fed by a live `Video` row)
   * always supplies it.
   */
  accessTierOverride?: string | null;
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
  /**
   * Explicit catalog classification - `drama` for real user-facing content,
   * `qa_fixture` for internal technical fixtures kept in the catalog on
   * purpose. Persisted on `Video.contentKind`; never inferred from title,
   * channel, language, storage key or dimensions. Required rather than
   * optional so every construction site has to declare it.
   */
  contentKind: VideoContentKind;
  /**
   * Work unit "Episode Access-Tier + Category Contract Hardening": the
   * resolved (effective) access tier for THIS episode — `"premium"` if
   * streaming/playback requires an active entitlement, `"free"` if it does
   * not. Computed by `toVideoResponseDto` via the single authoritative
   * `resolveAccessTier` function (`entitlements/entitlement.constants.ts`)
   * — the EXACT SAME rule `VideosController#enforceEntitlementGate` already
   * enforces at `/stream`/`/playback` request time (via
   * `EntitlementsService.resolveEpisodePremium`, which now delegates to the
   * same function), and the same rule `SeriesPublicDto.hasPremiumEpisodes`
   * aggregates over — so this field can never disagree with the real
   * authorization decision or with the series-level aggregate.
   *
   * ADDITIVE: present on every `VideoResponseDto` (`/videos/feed`,
   * `/videos/:id`, and `/series/:id`'s embedded episodes, since all three
   * are built from this same shared shape) — existing consumers that only
   * read the previously-existing fields are unaffected. The raw admin-set
   * override that may have produced this value (`Video.accessTierOverride`)
   * is deliberately NEVER exposed here — see `AdminMediaDto
   * .accessTierOverride` (`media.types.ts`) for its only intended exposure.
   */
  accessTier: 'free' | 'premium';
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

/**
 * Slice 11Q — Private HLS Delivery Gateway (control-workspace DECISIONS.md
 * "2026-08-10 — Slice 11Q APPROVED..." entry). `GET /videos/:id/playback`'s
 * response for an HLS-ready row (`processingState === 'ready'` and
 * `hlsMasterKey` set) — a SEPARATE, additive response shape from
 * `VideoPlaybackResponseDto` above, never merged into it: every non-HLS
 * row's response stays byte-identical to before this slice (no `type`
 * field was retrofitted onto the existing shape).
 */
export interface HlsRenditionPlaybackDto {
  /** Rung name, e.g. "360p"/"540p"/"720p"/"1080p" (`HlsRenditionSummary.name`). */
  quality: string;
  width: number;
  height: number;
  /** Gateway-relative URL: `<HLS_GATEWAY_BASE_URL>/t/<token>/<quality>/index.m3u8`. */
  url: string;
}

export interface HlsPlaybackResponseDto {
  type: 'hls';
  /** Gateway-relative URL: `<HLS_GATEWAY_BASE_URL>/t/<token>/master.m3u8`. */
  masterUrl: string;
  /** ONLY the renditions actually produced for this generation (`Video.hlsRenditions`) — never a speculative full ladder. */
  renditions: HlsRenditionPlaybackDto[];
  /** ISO-8601 — when the single token covering both masterUrl and every rendition url expires. */
  expiresAt: string;
}
