-- Phase 11, work unit 11F-4: data-only backfill. NO schema/DDL change — the
-- "Video"."accessTierOverride" column already exists (added by migration
-- 20260725051936_add_video_access_tier_override) and is left exactly as-is
-- here (still TEXT, still nullable, still no default).
--
-- Fills every row where "accessTierOverride" IS NULL (i.e. every row that
-- has never had an explicit per-episode override set via
-- PATCH /admin/media/:id/access-tier) with the value the existing default
-- rule already derives for it today (EntitlementsService.isEpisodePremium /
-- deriveAccessTier in src/entitlements/entitlement.constants.ts):
-- "episodeNumber" <= 5 (the current FREE_EPISODE_LIMIT) -> 'free',
-- "episodeNumber" > 5 -> 'premium'. This changes only the STORED value, not
-- the STREAMING/ENTITLEMENT OUTCOME for any of the 40 pre-existing rows:
-- EntitlementsService#resolveEpisodePremium already special-cases
-- accessTierOverride = 'free' to return false and 'premium' to return true,
-- which is exactly what isEpisodePremium(episodeNumber, 5) would already
-- have returned for these rows before this migration ran (via the null
-- fallback branch) — so every existing row's gating stays byte-for-byte
-- identical, it just now reads the answer from the column instead of
-- re-deriving it from episodeNumber on every request.
--
-- The WHERE clause below is the whole safety property this migration
-- depends on: it can NEVER touch a row that already carries an explicit
-- override (e.g. one an admin set via the 11E-3 endpoint before this
-- migration ran, including one that intentionally disagrees with the
-- episodeNumber-derived default) — such a row's "accessTierOverride" is
-- already non-NULL and is therefore excluded from this UPDATE entirely.
--
-- Reversible: this migration only assigns values to an already-nullable
-- column. It can be fully undone with a follow-up data-only migration doing
-- UPDATE "Video" SET "accessTierOverride" = NULL; — no data loss, since the
-- underlying "episodeNumber" values this derivation reads are never
-- modified by this migration, and re-deriving from them is exactly what the
-- pre-11F-4 code path already did at request time.
UPDATE "Video"
SET "accessTierOverride" = CASE
  WHEN "episodeNumber" > 5 THEN 'premium'
  ELSE 'free'
END
WHERE "accessTierOverride" IS NULL;
