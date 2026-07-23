/**
 * Phase 10, work unit 10-B2/10-B3: mirrors mobile's
 * `src/services/videos/series-service.ts::FREE_EPISODE_LIMIT` exactly.
 * Episodes 1-5 (inclusive) are free for any authenticated user; 6+ require
 * an active entitlement. Kept as a single source of truth on this side so
 * `VideosController`'s stream guard and any future entitlement-aware
 * endpoint agree with each other without duplicating the literal `5`.
 */
export const FREE_EPISODE_LIMIT = 5;
