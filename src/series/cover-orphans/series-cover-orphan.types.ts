import { StorageService } from '../../storage/storage.service';

/**
 * Slice "SERIES COVER ORPHAN CLEANUP LIFECYCLE": report/run shapes for
 * `SeriesCoverOrphanService`. Kept as a small, self-contained "report" type
 * (mirroring `retention/retention.types.ts` and `importer/dryrun.types.ts`,
 * this codebase's existing "describe what WOULD happen" precedents) rather
 * than a Prisma- or SDK-derived type, so the CLI and the specs depend on a
 * stable contract independent of the underlying queries.
 */

/**
 * The EXACT subset of `StorageService` this sweep is allowed to use.
 *
 * Derived with `Pick` from the real class rather than hand-declared, so it
 * cannot drift from the production signatures — and so the sweep provably
 * has no reach for `putObject`, `createPresignedPutUrl`, or anything else
 * that could write to, or mint credentials for, the bucket. It lists exactly
 * one read (`listObjectPageByPrefix`) and exactly one destructive call
 * (`deleteObject`, one exact key at a time — never a bulk/prefix delete).
 */
export type SeriesCoverOrphanStorage = Pick<
  StorageService,
  'listObjectPageByPrefix' | 'deleteObject'
>;

export interface RunSeriesCoverOrphanCleanupOptions {
  /**
   * Must be the literal boolean `true` for a single object to be deleted —
   * mirrors `RunRetentionOptions.commit`'s "literal `true`, not a truthy
   * string" precedent. Any other value (including omission) is a DRY RUN.
   * Defaults to `false`, so the destructive mode is never the default a
   * forgetful caller lands in.
   */
  apply?: boolean;
  /**
   * Injectable clock, defaulting to `new Date()`. Exists so tests can pin a
   * fixed instant and assert grace-window boundaries deterministically
   * (the `retention.integration.spec.ts` precedent) rather than racing the
   * real clock or sleeping.
   *
   * There is deliberately no `graceMs` option next to this: the only way to
   * move the eligibility boundary is to move `now`, so no caller can shrink
   * `SERIES_COVER_ORPHAN_GRACE_MS` itself.
   *
   * DIRECTIONALITY, stated plainly because it is the one knob here that can
   * point the wrong way: a `now` in the PAST moves the cutoff back and makes
   * the sweep strictly more conservative, while a `now` in the FUTURE moves
   * the cutoff forward and would make more objects eligible. That is why no
   * operator surface exposes it — `runSeriesCoverOrphansCli` calls
   * `run({ apply })` with NO `now` at all, so the sweep always uses the real
   * clock in production. That is not merely a convention: the CLI's spec
   * asserts the call with an exact-equality `toHaveBeenCalledWith({ apply })`,
   * which fails the moment a `now` is added to it.
   */
  now?: Date;
}

/** What the sweep decided about one eligible candidate. */
export type SeriesCoverOrphanOutcome =
  /** Dry run: reported, never touched. */
  | 'dry-run'
  /** Apply run: the object was deleted from storage. */
  | 'deleted'
  /** Apply run: `deleteObject` threw; nothing else was affected. */
  | 'failed'
  /** Apply run: the pre-delete database recheck found a live reference. */
  | 'skipped-on-recheck';

export interface SeriesCoverOrphanCandidate {
  key: string;
  /** Recovered from `key` via the canonical builder's own validator. */
  seriesId: string;
  /** `LastModified` as reported by `ListObjectsV2` — never a locally invented timestamp. */
  lastModified: Date;
  ageMs: number;
  /**
   * The single reason this key became a candidate. A one-member union today,
   * spelled out rather than implied, so the report says WHY in the operator's
   * output instead of leaving them to infer it.
   */
  reason: 'unreferenced-and-past-grace';
  outcome: SeriesCoverOrphanOutcome;
}

/**
 * Every counter is exact and complete for the whole sweep, even when
 * `candidates` below is truncated.
 *
 * The buckets are MUTUALLY EXCLUSIVE and, together, total `scanned`:
 *
 *   scanned = ignoredForeignKey + protected + unknownAge + tooRecent
 *           + seriesRecentlyModified + eligible
 *
 * and, within `eligible`:
 *
 *   eligible = deleted + failed + skippedOnRecheck   (apply run)
 *   eligible = the dry-run candidate count            (dry run; deleted = 0)
 *
 * Classification precedence is deliberate and fixed (see
 * `SeriesCoverOrphanService.processPage`): protected wins over every other
 * bucket, so a key that is BOTH the live cover and brand new is reported as
 * `protected`, which is the fact an operator actually needs.
 */
export interface SeriesCoverOrphanReport {
  generatedAt: Date;
  /** `false` for a dry run — in which case `deleted` is always exactly 0. */
  apply: boolean;
  graceMs: number;
  /** Objects with `lastModified < cutoff` are old enough; `>= cutoff` are not. */
  cutoff: Date;
  /** `ListObjectsV2` pages actually consumed by this sweep. */
  pagesScanned: number;
  /**
   * `true` when the sweep hit `SERIES_COVER_ORPHAN_MAX_PAGES` while the
   * provider still had more keys — i.e. this run did NOT see the whole
   * namespace. Never silently swallowed: the CLI prints it, and the service
   * logs a warning.
   */
  listTruncated: boolean;
  /** Objects returned under the Series-cover root prefix. */
  scanned: number;
  /** Under the root prefix but NOT a well-formed Series-cover key — never a candidate. */
  ignoredForeignKey: number;
  /** Referenced right now by some `Series.coverImageKey` or `Series.pendingCoverImageKey`. */
  protected: number;
  /** `ListObjectsV2` reported no `LastModified`, so age is unprovable — treated as protected. */
  unknownAge: number;
  /** Unreferenced, but not yet older than the grace window. */
  tooRecent: number;
  /**
   * Unreferenced and past grace, but the owning `Series` row was itself
   * modified inside the grace window — see
   * `SeriesCoverOrphanService.loadRecentlyModifiedSeriesIds` for why a
   * recently-touched row makes its whole cover namespace off-limits.
   */
  seriesRecentlyModified: number;
  eligible: number;
  /** Always exactly 0 on a dry run. */
  deleted: number;
  /** `deleteObject` threw. The sweep continued; nothing in the database changed. */
  failed: number;
  /** Eligible at enumeration time, but referenced again by the pre-delete recheck. */
  skippedOnRecheck: number;
  /** Bounded detail list; see `candidatesTruncated`. Counters above are never truncated. */
  candidates: SeriesCoverOrphanCandidate[];
  /** `true` when more candidates existed than `SERIES_COVER_ORPHAN_MAX_REPORTED_CANDIDATES`. */
  candidatesTruncated: boolean;
}
