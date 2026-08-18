import { DEFAULT_PUT_URL_EXPIRY_SECONDS } from '../../storage/storage.constants';

/**
 * Slice "SERIES COVER ORPHAN CLEANUP LIFECYCLE": named-constant policy for
 * the bounded sweep that reclaims Series-cover objects in R2 which no
 * `Series` row references any more.
 *
 * Deliberately its OWN policy, separate from `transcode/transcode.constants
 * .ts`'s `TRANSCODE_CLEANUP_GRACE_MINUTES` (the HLS janitor's 120-minute
 * window) and from `retention/retention.constants.ts`'s day-granularity
 * database windows: an HLS generation is deleted only when a NEWER
 * generation is already the live pointer for the SAME row (so the row itself
 * proves the old one is dead), whereas a Series-cover orphan is frequently
 * an object with NO row pointing at it at all — including objects for a
 * `Series` row that was hard-deleted. That is a materially weaker piece of
 * evidence, so this policy's grace window is materially longer.
 */

/**
 * How old an UNREFERENCED object must be before it may be deleted:
 * **24 hours**.
 *
 * Derivation, not a round number picked for looks:
 *
 * 1. `DEFAULT_PUT_URL_EXPIRY_SECONDS` (15 minutes) is the hard upper bound
 *    on when bytes can even LAND at a freshly minted cover key — after the
 *    presigned PUT expires, R2 itself rejects the upload. So an object can
 *    never appear "new" more than 15 minutes after its intent was recorded.
 * 2. Completion (`POST /admin/series/:id/cover/complete`) is a SEPARATE
 *    admin action, taken after the browser upload finishes. A slow upload on
 *    a poor connection, an admin who uploads and then walks away from the
 *    tab before confirming, or a retried completion after a transient
 *    verification failure can all put hours between "bytes landed" and
 *    "cover became live".
 * 3. Operational safety: the operator-facing surface is dry-run first (see
 *    `run-series-cover-orphans-cli.ts`). A window measured in hours means a
 *    dry run reliably shows a candidate on one working day and it is still
 *    a candidate on the next, so a human can inspect the list before any
 *    apply run — a window measured in minutes would churn the report between
 *    the inspection and the decision.
 *
 * 24 hours is ~96x the presigned-PUT ceiling in (1) and comfortably covers
 * (2) and (3). It is deliberately NOT env-overridable: there is no
 * `SERIES_COVER_ORPHAN_GRACE_*` variable anywhere in this codebase, so no
 * operator, script, or misconfigured deployment can shrink the window from
 * outside the source tree. Tests cross the boundary by passing an explicit
 * `now` (`RunSeriesCoverOrphanCleanupOptions.now`), never by shrinking this.
 */
export const SERIES_COVER_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * The presigned-PUT ceiling this grace window is derived from, in
 * milliseconds. Exported purely so
 * `series-cover-orphan.constants.spec.ts` can pin the DERIVATION — that
 * `SERIES_COVER_ORPHAN_GRACE_MS` dominates it by a wide margin — as a real
 * assertion rather than as a claim in a comment. If a future change raises
 * `DEFAULT_PUT_URL_EXPIRY_SECONDS` past this window, that spec fails loudly
 * instead of the sweep silently becoming unsafe.
 */
export const SERIES_COVER_UPLOAD_WINDOW_MS =
  DEFAULT_PUT_URL_EXPIRY_SECONDS * 1000;

/**
 * `MaxKeys` for ONE `ListObjectsV2` page. 1000 is the S3/R2 protocol maximum
 * per page — asking for more is silently clamped by the provider, so this is
 * "one full page", not an arbitrary application number.
 */
export const SERIES_COVER_ORPHAN_LIST_PAGE_SIZE = 1000;

/**
 * Hard ceiling on pages consumed by ONE sweep: 100 pages x 1000 keys =
 * 100,000 objects examined per run, after which the sweep stops and reports
 * `listTruncated: true` rather than continuing.
 *
 * This is what makes "no infinite listing loop" a structural property: the
 * `while` loop in `SeriesCoverOrphanService.run` is bounded by this counter
 * FIRST and by the presence of a continuation token second, so even a
 * provider that pathologically returned a token forever would terminate.
 * A truncated sweep is reported loudly (never silently), because "we only
 * looked at the first N objects" and "there was nothing else to find" must
 * not be indistinguishable in the operator's output.
 */
export const SERIES_COVER_ORPHAN_MAX_PAGES = 100;

/**
 * Cap on how many candidate records the returned report ENUMERATES. Every
 * numeric counter in the report stays exact and complete regardless — this
 * bounds only the detail array a dry run prints, so one sweep's peak memory
 * is bounded by (one page of list entries) + (this many candidate records),
 * never by the size of the bucket.
 */
export const SERIES_COVER_ORPHAN_MAX_REPORTED_CANDIDATES = 500;
