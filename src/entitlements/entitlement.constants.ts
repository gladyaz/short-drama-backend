/**
 * Phase 10, work unit 10-B2/10-B3: mirrors mobile's
 * `src/services/videos/series-service.ts::FREE_EPISODE_LIMIT` exactly.
 * Episodes 1-5 (inclusive) are free for any authenticated user; 6+ require
 * an active entitlement. Kept as a single source of truth on this side so
 * `VideosController`'s stream guard and any future entitlement-aware
 * endpoint agree with each other without duplicating the literal `5`.
 */
export const FREE_EPISODE_LIMIT = 5;

/** The two explicit values `Video.accessTierOverride` may hold (besides
 * `null`, meaning "no explicit tier yet"). Phase 11, work unit 11F-4. */
export type AccessTier = 'free' | 'premium';

/**
 * Phase 11, work unit 11F-4: the same free/premium decision as
 * `EntitlementsService.isEpisodePremium`, expressed as the tier label stored
 * in `Video.accessTierOverride` rather than a stream-guard boolean. A pure
 * function (no Nest DI) so it can be reused outside the request lifecycle —
 * `prisma/seed.ts` instantiates `PrismaClient` directly and has no access to
 * `EntitlementsService`, and `AdminMediaService.createUpload` uses it to give
 * every newly created row an explicit tier at creation time. Deliberately
 * duplicates none of `isEpisodePremium`'s logic inline; both ultimately
 * express the same `episodeNumber > freeEpisodeLimit` boundary so the two can
 * never drift against each other.
 */
export function deriveAccessTier(
  episodeNumber: number,
  freeEpisodeLimit: number = FREE_EPISODE_LIMIT,
): AccessTier {
  return episodeNumber > freeEpisodeLimit ? 'premium' : 'free';
}

/**
 * Work unit "Episode Access-Tier + Category Contract Hardening": the ONE
 * authoritative override-vs-default resolver for an episode's effective
 * access tier. An explicit `accessTierOverride` of `"free"` or `"premium"`
 * always wins, regardless of `episodeNumber`; a `null`/`undefined` override
 * (no explicit tier set) falls back to `deriveAccessTier`'s existing
 * `episodeNumber > freeEpisodeLimit` boundary — this function never
 * re-implements that boundary itself, it delegates to `deriveAccessTier` so
 * the two can never drift.
 *
 * Every consumer that needs to know "is this episode premium" goes through
 * THIS function (directly, or via `EntitlementsService.resolveEpisodePremium`,
 * which now delegates here): the stream/playback authorization gate
 * (`VideosController#enforceEntitlementGate`), the `SeriesPublicDto
 * .hasPremiumEpisodes` aggregate (`PublicSeriesService`), and the public
 * `VideoResponseDto.accessTier` field (`video-response.util.ts`) — so the
 * three can never independently drift from each other. Pure (no Nest DI, no
 * I/O), mirroring `deriveAccessTier`'s own design, specifically so it stays
 * usable from `video-response.util.ts`, which must remain a plain
 * synchronous module with no request-lifecycle dependency.
 */
export function resolveAccessTier(
  input: {
    accessTierOverride: string | null | undefined;
    episodeNumber: number;
  },
  freeEpisodeLimit: number = FREE_EPISODE_LIMIT,
): AccessTier {
  if (
    input.accessTierOverride === 'premium' ||
    input.accessTierOverride === 'free'
  ) {
    return input.accessTierOverride;
  }

  return deriveAccessTier(input.episodeNumber, freeEpisodeLimit);
}
