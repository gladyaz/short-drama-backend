import { IsIn } from 'class-validator';

/**
 * Body of `PATCH /admin/media/:id/access-tier` (work unit 11E-3): sets or
 * clears the per-episode `Video.accessTierOverride` column. `tier` is
 * REQUIRED (unlike `UpdateMediaMetadataDto`'s fields, which are all
 * `@IsOptional()`) and must be exactly one of three values:
 * - `"premium"` — always requires an active entitlement, regardless of
 *   `episodeNumber`.
 * - `"free"` — always streamable without an entitlement, regardless of
 *   `episodeNumber`.
 * - `null` — clears the override, reverting to the existing default
 *   `episodeNumber >= FREE_EPISODE_LIMIT` rule (`isEpisodePremium`).
 *
 * `@IsIn` (class-validator's own array-membership check, not the
 * string-only `validator` package one) compares with `===`, so `null` is a
 * genuinely valid, validated value here — this deliberately does NOT use
 * `@IsOptional()`, since an entirely missing `tier` field must be rejected
 * with a 400 (there is no sensible "no-op" default for this endpoint), not
 * silently skipped.
 */
export class UpdateAccessTierDto {
  @IsIn(['free', 'premium', null])
  tier!: 'free' | 'premium' | null;
}
