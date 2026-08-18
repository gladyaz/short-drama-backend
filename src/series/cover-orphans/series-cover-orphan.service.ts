import { Injectable, Logger } from '@nestjs/common';
import { redactSensitiveText } from '../../common/logging/redact';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import {
  SERIES_COVER_ORPHAN_GRACE_MS,
  SERIES_COVER_ORPHAN_LIST_PAGE_SIZE,
  SERIES_COVER_ORPHAN_MAX_PAGES,
  SERIES_COVER_ORPHAN_MAX_REPORTED_CANDIDATES,
} from './series-cover-orphan.constants';
import { assertSeriesCoverOrphanApplyAllowed } from './series-cover-orphan-env-guard';
import {
  SERIES_COVER_OBJECT_KEY_ROOT_PREFIX,
  parseSeriesCoverObjectKey,
} from './series-cover-orphan-key.util';
import {
  RunSeriesCoverOrphanCleanupOptions,
  SeriesCoverOrphanCandidate,
  SeriesCoverOrphanOutcome,
  SeriesCoverOrphanReport,
} from './series-cover-orphan.types';

/** One listed object that parsed as a well-formed Series-cover key. */
interface CoverObject {
  key: string;
  seriesId: string;
  lastModified?: Date;
}

/** Running totals + bounded detail list for one sweep. */
interface SweepTally {
  scanned: number;
  ignoredForeignKey: number;
  protectedCount: number;
  unknownAge: number;
  tooRecent: number;
  seriesRecentlyModified: number;
  eligible: number;
  deleted: number;
  failed: number;
  skippedOnRecheck: number;
  candidates: SeriesCoverOrphanCandidate[];
  candidatesTruncated: boolean;
}

/**
 * Slice "SERIES COVER ORPHAN CLEANUP LIFECYCLE": the bounded, dry-run-first
 * sweep that reclaims Cloudflare R2 objects under the Series-cover namespace
 * which no `Series` row references any more.
 *
 * ## What an orphan is
 *
 * An object under `admin-series/` whose key is a well-formed Series-cover key
 * and which, at sweep time, is referenced by NEITHER `Series.coverImageKey`
 * NOR `Series.pendingCoverImageKey` on ANY row — and which is older than
 * `SERIES_COVER_ORPHAN_GRACE_MS`. Four known ways one is produced, all of
 * them consequences of the cover contract deliberately choosing correctness
 * over aggressive cleanup:
 *
 *  A. Presign issued, browser uploaded the bytes, the admin closed the tab
 *     and `.../cover/complete` was never called.
 *  B. Intent A's object landed, then a newer intent B overwrote
 *     `pendingCoverImageKey`; A can no longer complete (the compare-and-set
 *     rejects it) and its object is stranded.
 *  C. The upload succeeded but completion failed a bounded verification
 *     check (content type / size / missing object), leaving the bytes.
 *  D. A replacement completed successfully; the PREVIOUS cover object is
 *     intentionally never deleted inline, because a client may still be
 *     mid-download of it through a live presigned GET.
 *
 * Plus a fifth, from the row side: `SeriesService.remove` hard-deletes a
 * `Series` row without touching storage at all, so that series' cover
 * objects survive with no row left to reference them.
 *
 * ## The primary safety invariant
 *
 * An object is NEVER removed while any `Series` row's `coverImageKey` or
 * `pendingCoverImageKey` equals its key. That is checked TWICE — once from
 * the page-scoped reference snapshot, and once again immediately before each
 * individual delete (`findReferencingSeriesId`). Anything unprovable is
 * skipped: a key that will not parse, an entry with no `LastModified`, a
 * series row touched inside the grace window. False orphan RETENTION is an
 * acceptable outcome of this sweep; removing a live cover is not.
 *
 * ## Enumeration is storage-driven, not row-driven
 *
 * Unlike `TranscodeJanitorService.cleanupOrphanStaging` — which iterates
 * candidate `Video` ROWS and lists each one's own prefix — this sweep pages
 * through the whole `admin-series/` namespace. It must: an orphan left by a
 * hard-deleted `Series` row has no row to iterate from, and a row-driven
 * sweep would therefore never see it. The cost of that choice is that the
 * enumeration is unbounded in principle, which is why it is explicitly
 * bounded in practice — one `ListObjectsV2` page at a time, at most
 * `SERIES_COVER_ORPHAN_MAX_PAGES` pages, processed and discarded page by
 * page so the bucket is never loaded into memory.
 *
 * ## Dry run is the unconditional default
 *
 * `run()` without `apply: true` never reaches `deleteObject` at all — the
 * call sits behind a plain early return in `disposeEligible`, not behind a
 * shared "maybe delete" helper that could fire regardless of the flag. This
 * mirrors `RetentionService`'s identical discipline for `commit`.
 *
 * ## Not scheduled
 *
 * This class carries no `@Cron` decorator, is registered in no scheduler, and
 * is reachable from no HTTP route. Its only invocation surface is the
 * explicit CLI (`npm run maintenance:series-cover-orphans`). It is a plain
 * injectable so a future, separately approved work unit COULD schedule it the
 * way `RetentionSchedulerService` schedules retention — that unit does not
 * exist, and this one deliberately does not create it.
 */
@Injectable()
export class SeriesCoverOrphanService {
  private readonly logger = new Logger(SeriesCoverOrphanService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
  ) {}

  /** Convenience alias for a dry run — identical to `run({ apply: false })`. */
  async buildReport(now?: Date): Promise<SeriesCoverOrphanReport> {
    return this.run({ apply: false, now });
  }

  async run(
    options: RunSeriesCoverOrphanCleanupOptions = {},
  ): Promise<SeriesCoverOrphanReport> {
    const apply = options.apply === true;
    const now = options.now ?? new Date();

    // The production guard runs FIRST, before any storage or database call,
    // so a refusal means literally zero I/O happened for this run.
    if (apply) {
      assertSeriesCoverOrphanApplyAllowed();
    }

    const cutoff = new Date(now.getTime() - SERIES_COVER_ORPHAN_GRACE_MS);
    const tally = createEmptyTally();

    let continuationToken: string | undefined;
    let pagesScanned = 0;

    // Bounded by the page ceiling FIRST and the continuation token second —
    // a provider that pathologically returned a token forever still
    // terminates here.
    while (pagesScanned < SERIES_COVER_ORPHAN_MAX_PAGES) {
      const page = await this.storageService.listObjectPageByPrefix(
        SERIES_COVER_OBJECT_KEY_ROOT_PREFIX,
        {
          maxKeys: SERIES_COVER_ORPHAN_LIST_PAGE_SIZE,
          continuationToken,
        },
      );

      pagesScanned += 1;
      await this.processPage(page.entries, now, cutoff, apply, tally);

      continuationToken = page.nextContinuationToken;
      if (continuationToken === undefined) {
        break;
      }
    }

    const listTruncated = continuationToken !== undefined;
    if (listTruncated) {
      // Never a silent cap: "we stopped early" and "there was nothing more"
      // must not look identical to an operator.
      this.logger.warn(
        redactSensitiveText(
          `Series cover orphan sweep stopped at its ${SERIES_COVER_ORPHAN_MAX_PAGES}-page ` +
            `ceiling with more keys remaining under "${SERIES_COVER_OBJECT_KEY_ROOT_PREFIX}". ` +
            'This run did NOT examine the whole namespace; re-run after this ' +
            "run's candidates are resolved.",
        ),
      );
    }

    return {
      generatedAt: now,
      apply,
      graceMs: SERIES_COVER_ORPHAN_GRACE_MS,
      cutoff,
      pagesScanned,
      listTruncated,
      scanned: tally.scanned,
      ignoredForeignKey: tally.ignoredForeignKey,
      protected: tally.protectedCount,
      unknownAge: tally.unknownAge,
      tooRecent: tally.tooRecent,
      seriesRecentlyModified: tally.seriesRecentlyModified,
      eligible: tally.eligible,
      deleted: tally.deleted,
      failed: tally.failed,
      skippedOnRecheck: tally.skippedOnRecheck,
      candidates: tally.candidates,
      candidatesTruncated: tally.candidatesTruncated,
    };
  }

  /**
   * Classifies ONE `ListObjectsV2` page and disposes of whatever it finds
   * eligible, then returns — the page's entries are not retained, which is
   * what keeps peak memory a function of the page size rather than of the
   * bucket size.
   *
   * The classification precedence below is fixed and load-bearing:
   *
   *   parse failure > protected > unknown age > too recent
   *                 > series recently modified > eligible
   *
   * `protected` deliberately outranks the age buckets so that a key which is
   * both brand new AND the live cover is reported as protected — the fact an
   * operator reading the report actually needs. Because the buckets are
   * checked in this order with `continue`, every scanned object lands in
   * exactly one of them, and the counters sum to `scanned`.
   */
  private async processPage(
    entries: readonly { key: string; lastModified?: Date }[],
    now: Date,
    cutoff: Date,
    apply: boolean,
    tally: SweepTally,
  ): Promise<void> {
    const covers: CoverObject[] = [];

    for (const entry of entries) {
      tally.scanned += 1;

      const parsed = parseSeriesCoverObjectKey(entry.key);
      if (parsed === null) {
        // Under `admin-series/` but not a key this backend could have
        // minted. Counted, reported, and left completely alone.
        tally.ignoredForeignKey += 1;
        continue;
      }

      covers.push({
        key: entry.key,
        seriesId: parsed.seriesId,
        lastModified: entry.lastModified,
      });
    }

    if (covers.length === 0) {
      return;
    }

    const protectedKeys = await this.loadProtectedKeys(
      covers.map((cover) => cover.key),
    );
    const recentlyModifiedSeriesIds = await this.loadRecentlyModifiedSeriesIds(
      [...new Set(covers.map((cover) => cover.seriesId))],
      cutoff,
    );

    for (const cover of covers) {
      if (protectedKeys.has(cover.key)) {
        tally.protectedCount += 1;
        continue;
      }

      if (cover.lastModified === undefined) {
        // Age is unprovable. A real S3/R2 listing always carries
        // `LastModified`, but the SAFE default for a degenerate response is
        // "treat as too new to touch" — never remove what cannot be proven
        // old. Same posture as `TranscodeJanitorService`'s missing-timestamp
        // branch.
        tally.unknownAge += 1;
        continue;
      }

      // Strictly OLDER than the cutoff. An object exactly at the boundary is
      // still within grace — the eligibility test is `<`, never `<=`.
      if (cover.lastModified.getTime() >= cutoff.getTime()) {
        tally.tooRecent += 1;
        continue;
      }

      if (recentlyModifiedSeriesIds.has(cover.seriesId)) {
        tally.seriesRecentlyModified += 1;
        continue;
      }

      tally.eligible += 1;
      await this.disposeEligible(cover, cover.lastModified, now, apply, tally);
    }
  }

  /**
   * The one place `deleteObject` can be reached from — and it is reached only
   * after BOTH the dry-run early return and the pre-delete database recheck.
   */
  private async disposeEligible(
    cover: CoverObject,
    lastModified: Date,
    now: Date,
    apply: boolean,
    tally: SweepTally,
  ): Promise<void> {
    const ageMs = now.getTime() - lastModified.getTime();

    if (!apply) {
      // DRY RUN. A plain early return placed BEFORE the delete call, rather
      // than a `apply ? delete : noop` helper, so no future edit can make the
      // destructive branch reachable by accident.
      recordCandidate(tally, cover, lastModified, ageMs, 'dry-run');
      return;
    }

    // FINAL RECHECK. Enumeration and deletion are separated in time — by the
    // rest of the page's processing, by every earlier delete's round trip,
    // and potentially by many pages. The page-scoped snapshot above is
    // therefore not sufficient on its own: this asks the database again, for
    // THIS key, across ALL series, at the last possible moment.
    //
    // Querying by KEY rather than by the key's own `seriesId` is deliberate
    // and load-bearing: `UpdateSeriesDto.coverImageKey` and
    // `CreateSeriesDto.coverImageKey` accept ANY 1-500 character string with
    // no shape validation, so an admin can point series B's `coverImageKey`
    // at a key minted under series A's prefix. A recheck scoped to the
    // parsed `seriesId` would miss exactly that reference.
    const referencingSeriesId = await this.findReferencingSeriesId(cover.key);

    if (referencingSeriesId !== null) {
      tally.skippedOnRecheck += 1;
      recordCandidate(tally, cover, lastModified, ageMs, 'skipped-on-recheck');
      this.logger.log(
        redactSensitiveText(
          `Skipped Series cover orphan "${cover.key}": series ` +
            `"${referencingSeriesId}" referenced it again between enumeration ` +
            'and deletion.',
        ),
      );
      return;
    }

    try {
      await this.storageService.deleteObject(cover.key);
      tally.deleted += 1;
      recordCandidate(tally, cover, lastModified, ageMs, 'deleted');
      this.logger.log(
        redactSensitiveText(
          `Removed Series cover orphan "${cover.key}" (series ` +
            `"${cover.seriesId}", unreferenced, ${Math.round(ageMs / 3_600_000)}h old).`,
        ),
      );
    } catch (error) {
      // One object's failure never aborts the sweep, and never writes
      // anything to the database — there is no "deleted" column on `Series`
      // to desynchronize, so a failed delete simply leaves the object in
      // place for the next run to find. Mirrors the janitor's
      // "log loudly, never silently swallow, keep going" precedent.
      tally.failed += 1;
      recordCandidate(tally, cover, lastModified, ageMs, 'failed');
      this.logger.error(
        redactSensitiveText(
          `Failed to remove Series cover orphan "${cover.key}" (series ` +
            `"${cover.seriesId}"): ${String(error)}`,
        ),
      );
    }
  }

  /**
   * The AUTHORITATIVE reference snapshot for one page: every key in `keys`
   * that some `Series` row currently points at, via either column.
   *
   * Scoped to the page's own keys (an `IN` list bounded by
   * `SERIES_COVER_ORPHAN_LIST_PAGE_SIZE`) rather than loading every
   * `Series` row's two key columns into memory. That is both strictly more
   * memory-bounded and strictly fresher than a whole-table snapshot taken
   * once at the start of the sweep, and it is equally authoritative: the
   * question being asked is only ever "is THIS key referenced right now".
   *
   * Deliberately NOT scoped by the keys' parsed `seriesId` — see
   * `disposeEligible`'s recheck comment for why a cross-series reference is
   * reachable through the raw-key PATCH/POST surface and must be caught.
   */
  private async loadProtectedKeys(keys: string[]): Promise<Set<string>> {
    const rows = await this.prisma.series.findMany({
      where: {
        OR: [
          { coverImageKey: { in: keys } },
          { pendingCoverImageKey: { in: keys } },
        ],
      },
      select: { coverImageKey: true, pendingCoverImageKey: true },
    });

    const candidateKeys = new Set(keys);
    const protectedKeys = new Set<string>();

    for (const row of rows) {
      // A matched row can carry a second key that is NOT in this page (its
      // pending intent while its live cover matched, say) — intersecting
      // against `candidateKeys` keeps the returned set exactly "keys from
      // this page that are protected", so the caller's counters stay sound.
      if (row.coverImageKey !== null && candidateKeys.has(row.coverImageKey)) {
        protectedKeys.add(row.coverImageKey);
      }
      if (
        row.pendingCoverImageKey !== null &&
        candidateKeys.has(row.pendingCoverImageKey)
      ) {
        protectedKeys.add(row.pendingCoverImageKey);
      }
    }

    return protectedKeys;
  }

  /**
   * Series ids whose row was itself modified inside the grace window.
   *
   * DEFENSE IN DEPTH against the one genuinely reachable race in this
   * design. `PATCH /admin/series/:id` accepts an arbitrary raw
   * `coverImageKey` string, so an admin can "restore" a previously
   * unreferenced key by hand. The pre-delete recheck already catches such a
   * restore that has already committed; this check additionally holds back
   * the WHOLE cover namespace of any series whose row changed recently, so a
   * series being actively edited by a human is never swept at the same time.
   * A key only becomes eligible once its series has been quiet for the full
   * grace window.
   *
   * The cost is purely extra retention: a series edited daily never has its
   * historical covers reclaimed. That is the acceptable direction of error
   * for this sweep, and it is reported under its own counter rather than
   * being folded into `tooRecent`, so the reason is visible.
   *
   * `updatedAt` is Prisma's `@updatedAt` on `Series`, bumped by every write
   * to the row — including the cover replacement that orphaned the old
   * object in the first place, which is why a replaced cover becomes
   * eligible a grace window after the REPLACEMENT, not after the upload.
   */
  private async loadRecentlyModifiedSeriesIds(
    seriesIds: string[],
    cutoff: Date,
  ): Promise<Set<string>> {
    const rows = await this.prisma.series.findMany({
      where: { id: { in: seriesIds }, updatedAt: { gte: cutoff } },
      select: { id: true },
    });

    return new Set(rows.map((row) => row.id));
  }

  /**
   * The id of a series referencing `key` through either column right now, or
   * `null`. A `findFirst` rather than a `count`: the id makes the skip log
   * actionable, and one matching row is all the answer the caller needs.
   */
  private async findReferencingSeriesId(key: string): Promise<string | null> {
    const row = await this.prisma.series.findFirst({
      where: {
        OR: [{ coverImageKey: key }, { pendingCoverImageKey: key }],
      },
      select: { id: true },
    });

    return row?.id ?? null;
  }
}

function createEmptyTally(): SweepTally {
  return {
    scanned: 0,
    ignoredForeignKey: 0,
    protectedCount: 0,
    unknownAge: 0,
    tooRecent: 0,
    seriesRecentlyModified: 0,
    eligible: 0,
    deleted: 0,
    failed: 0,
    skippedOnRecheck: 0,
    candidates: [],
    candidatesTruncated: false,
  };
}

/**
 * Appends one candidate to the report's BOUNDED detail list. Past
 * `SERIES_COVER_ORPHAN_MAX_REPORTED_CANDIDATES` the record is dropped and the
 * truncation flag is raised — the numeric counters the caller already
 * incremented stay exact, so a truncated report under-lists but never
 * under-counts.
 */
function recordCandidate(
  tally: SweepTally,
  cover: CoverObject,
  lastModified: Date,
  ageMs: number,
  outcome: SeriesCoverOrphanOutcome,
): void {
  if (tally.candidates.length >= SERIES_COVER_ORPHAN_MAX_REPORTED_CANDIDATES) {
    tally.candidatesTruncated = true;
    return;
  }

  tally.candidates.push({
    key: cover.key,
    seriesId: cover.seriesId,
    lastModified,
    ageMs,
    reason: 'unreferenced-and-past-grace',
    outcome,
  });
}
