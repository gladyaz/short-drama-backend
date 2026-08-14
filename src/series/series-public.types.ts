import { VideoResponseDto } from '../videos/video.types';

/**
 * Work unit "SERIES METADATA + DISCOVER ARTWORK CONTRACT": the public,
 * unauthenticated view of a curated `Series` row, returned by
 * `GET /series` and (embedded in) `GET /series/:id`. Deliberately a
 * DIFFERENT shape from the admin-only `SeriesDto` (`./series.types.ts`):
 *
 *  - `coverImageKey` (a raw R2 object key, meaningless to a client and
 *    useless without credentials to sign it) is replaced by `coverUrl` — a
 *    ready-to-use, presigned URL, or `null` when no cover has been
 *    uploaded yet. Naming: `coverUrl`, not `posterUrl`, chosen to mirror
 *    the existing `xImageKey` -> `xUrl` transform already established (if
 *    unpopulated) on `VideoResponseDto.thumbnailUrl` for
 *    `Video.thumbnailImageKey` — `coverImageKey` -> `coverUrl` is the same
 *    transform applied to the field this DTO is actually built from
 *    (`Series.coverImageKey`), and keeps the two ends of the same
 *    key/URL pair textually paired (`coverImageKey` in, `coverUrl` out).
 *  - No `createdAt`/`updatedAt`/`archivedAt` — those describe *curation*
 *    history (when an admin created/edited/archived the row), not the
 *    content itself; the public catalog has no legitimate use for them and
 *    omitting them avoids inviting a client to treat them as a recency/
 *    "trending" signal, which this contract deliberately does not offer
 *    (rankings stay likes-based; no views/trending/dates are fabricated
 *    anywhere in this DTO).
 *  - Adds `category`/`sourceLanguage`/`episodeCount`/`totalLikes`/
 *    `hasPremiumEpisodes` — truthful aggregates computed from that
 *    series's own published, non-fixture (`contentKind: "drama"`) `Video`
 *    rows at request time (`PublicSeriesService`), never fabricated and
 *    never persisted on `Series` itself (so they can never go stale
 *    relative to the underlying `Video` rows).
 */
export interface SeriesPublicDto {
  id: string;
  title: string;
  /**
   * `null` when `Series.coverImageKey` is unset (true for every row this
   * repo's backfill creates today — no cover art has been uploaded yet,
   * see the migration's own doc comment) or when a presigned URL genuinely
   * cannot be produced. Never a fabricated/placeholder URL.
   */
  coverUrl: string | null;
  /**
   * The shared `category` value across every one of this series's
   * qualifying episodes, or `null` if there are none, or if they disagree
   * (never guessed — see `computeSeriesAggregate` in
   * `series-public.service.ts`).
   */
  category: string | null;
  /** Same "shared value or null" rule as `category`, for `sourceLanguage`. */
  sourceLanguage: string | null;
  /** Count of this series's published, `contentKind: "drama"` episodes. */
  episodeCount: number;
  /** Sum of `likeCount` across those same qualifying episodes. */
  totalLikes: number;
  /**
   * `true` if at least one qualifying episode requires an active
   * entitlement to stream, per the same `EntitlementsService
   * .resolveEpisodePremium` rule the stream/playback routes already
   * enforce (accessTierOverride, falling back to `episodeNumber >
   * FREE_EPISODE_LIMIT`) — never a separate/duplicated free/premium rule.
   */
  hasPremiumEpisodes: boolean;
}

/**
 * `GET /series`'s response envelope. Deliberately an `{ items: [...] }`
 * object, not a bare array — the admin `GET /admin/media` list already
 * establishes a paginated `{ items, total, page, pageSize }` envelope
 * precedent in this codebase (`docs/admin-api-contract.md`); wrapping in an
 * object here means real pagination fields (`total`/`page`/`pageSize`)
 * could be added to this SAME object later without breaking existing
 * clients (they would just keep reading `.items`). `total`/`page`/
 * `pageSize` are deliberately NOT included yet: with exactly 4 curated
 * series and no pagination actually implemented, adding those fields now
 * would be presenting fabricated/meaningless metadata as if it were real —
 * the same "no fabrication" rule this contract applies to dates and view
 * counts. This is an ADDITIVE difference from the unrelated, pre-existing
 * `GET /videos/feed`, which stays a bare `VideoResponseDto[]` — that route
 * is untouched by this work unit (see README.md's "Public catalog:
 * GET /series" section for the full rationale).
 */
export interface SeriesListResponseDto {
  items: SeriesPublicDto[];
}

/**
 * `GET /series/:id`'s response — `SeriesPublicDto` plus every one of this
 * series's qualifying episodes, in the exact same `VideoResponseDto` shape
 * `GET /videos/feed` already returns (built via the shared
 * `toVideoResponseDto` in `../videos/video-response.util.ts`, so the two
 * can never drift), ordered by `episodeNumber` ascending — the natural
 * within-series viewing order (distinct from `GET /videos/feed`'s own
 * `sortOrder`, which encodes the curated CROSS-series feed order, not an
 * intra-series one).
 */
export interface SeriesDetailPublicDto extends SeriesPublicDto {
  episodes: VideoResponseDto[];
}
