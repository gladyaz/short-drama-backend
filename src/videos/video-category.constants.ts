/**
 * Work unit "Episode Access-Tier + Category Contract Hardening": the closed,
 * canonical set of `Video.category` values.
 *
 * AUDIT (see DECISIONS.md's "Episode Access-Tier + Category Contract
 * Hardening" entry, Part B): no backend category constant/enum existed
 * before this work unit — `Video.category` has always been a freeform
 * `class-validator @IsString() @Length(1, 100)` field, validated only for
 * shape, never against a closed set. The only existing `VideoCategory`-style
 * constant anywhere in this project is on the MOBILE app
 * (`mobile-app-ecc/src/types/video.ts` / `video-mapper.ts`): a broader,
 * differently-cased, partly-speculative 8-value union (`Romance`, `Revenge`,
 * `Family`, `CEO`, `Historical`, `Action`, `Comedy`, `Drama`) that this
 * backend has never actually sent a value for beyond four of them, and never
 * in that casing. Per the approved work unit, this backend's own canonical
 * set is derived from what this backend ACTUALLY persists and documents, not
 * copied from mobile's list: a read-only audit of `short_drama_dev` found
 * exactly `action` (10), `comedy` (10), `drama` (11, incl. one legitimate
 * qa_fixture row), `romance` (10), plus exactly ONE non-canonical outlier —
 * `Drama` (capital D) on the known QA fixture `media-11rqa-8ac6a7f3` — left
 * untouched (no silent rewrite; see the audit report). These same four
 * lowercase values are exactly what `src/videos/videos.data.ts` (the
 * verified seed source for all 40 real curated episodes, one category per
 * series) uses, and exactly what `README.md`'s documented
 * `VideoResponseDto`/`SeriesPublicDto` examples already show.
 *
 * A plain `readonly string[]`, not a Postgres enum or DB `CHECK` constraint
 * — `Video.category` itself stays an unmodified plain `String` column,
 * matching this schema's own established `lifecycleState`/`contentKind`/
 * `Entitlement.tier` precedent (see `prisma/schema.prisma`'s comments on
 * those columns) of using a closed set enforced in application code rather
 * than a DB-level enum, specifically so a future 5th category needs only a
 * code change here, never a schema migration. This is the SMALLEST SOUND
 * enforcement for the stated goal ("no unknown strings entering the DB from
 * this point on, without a destructive rewrite of what's already there") —
 * an app-level closed validator at every write path, not a DB migration.
 *
 * Enforced on EVERY write path that can put a value in `Video.category`:
 * `CreateMediaUploadDto`/`UpdateMediaMetadataDto` (`POST`/`PATCH
 * /admin/media`), and `MediaImporterService.importItem` (the bulk importer,
 * work unit 11D-1 — not yet wired to any HTTP route, but a real write path
 * all the same). `prisma/seed.ts` sources its rows from `videos.data.ts`,
 * whose four literal category values are already exactly this set, so no
 * separate seed-time check was added — the seed source itself is the
 * originally-verified data this set was derived from.
 *
 * Deliberately NOT retroactively applied to the READ side
 * (`VideoRecord.category`/`VideoResponseDto.category`/`AdminMediaDto
 * .category` all stay plain `string`, unchanged): existing rows — including
 * the one known non-canonical `"Drama"` outlier — are never silently
 * rewritten or hidden, per the "no breaking wire change, no silent rewrite"
 * constraint. A row written before this work unit, or one whose value this
 * validator would reject if resubmitted, is still read back and served
 * exactly as persisted.
 */
export const VIDEO_CATEGORIES = [
  'action',
  'comedy',
  'drama',
  'romance',
] as const;

export type VideoCategory = (typeof VIDEO_CATEGORIES)[number];

/** Case-sensitive exact-match guard against `VIDEO_CATEGORIES` — used by
 * write paths (e.g. `MediaImporterService`) that do not go through a
 * class-validator DTO. */
export function isValidVideoCategory(value: string): value is VideoCategory {
  return (VIDEO_CATEGORIES as readonly string[]).includes(value);
}
