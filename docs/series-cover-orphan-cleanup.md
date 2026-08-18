# Series cover orphan cleanup

A bounded, dry-run-first maintenance sweep that reclaims Cloudflare R2 objects
under the Series-cover namespace which no `Series` row references any more.

> **Status.** Built and tested. It has **never been run destructively against
> any real bucket.** A real `--apply` run is a separate, explicitly
> human-approved action — see [Running it](#running-it).

---

## What an orphan is

An object is an orphan candidate only when **all** of the following hold at
sweep time:

1. Its key is under `admin-series/` **and** parses as a well-formed
   Series-cover key — `admin-series/<encodeURIComponent(seriesId)>/cover/<uuid v4>`,
   validated by the same predicate `POST /admin/series/:id/cover/complete`
   uses (`isValidSeriesCoverObjectKey`).
2. **No** `Series` row's `coverImageKey` references it.
3. **No** `Series` row's `pendingCoverImageKey` references it.
4. Its `LastModified` is **strictly older** than the grace window.
5. The `Series` row named by its key prefix was not itself modified inside
   the grace window.

Anything that fails any of these is skipped. Anything unprovable is skipped.

### Protected references

| Reference | Protected? |
|---|---|
| `Series.coverImageKey` (the live cover) | always, at any age |
| `Series.pendingCoverImageKey` (the current upload intent) | always, at any age |
| A key referenced by a **different** series than its prefix names | yes — the lookup is by key, across all series |
| An object with no `LastModified` in the listing | yes — age is unprovable, so it is never removed |
| Any object outside `admin-series/` | never enumerated at all |

`Video.coverImageKey`/`thumbnailImageKey` live under `admin-media/` and are
server-built (not admin-patchable), so no `Video` row can reference a
Series-cover key and no media object can enter this sweep's candidate list.

---

## Where orphans come from

| # | Cause |
|---|---|
| A | Presign issued, browser uploaded the bytes, `.../cover/complete` never called (tab closed). |
| B | Intent A's object landed, then a newer intent B overwrote `pendingCoverImageKey`. A can no longer complete — the compare-and-set rejects it — and its object is stranded. |
| C | The upload succeeded but completion failed a bounded verification check (content type, size, object missing). |
| D | A replacement completed successfully. The previous cover object is **intentionally** not deleted inline, because a client may still be mid-download of it through a live presigned GET. |
| E | `DELETE /admin/series/:id` hard-deletes the row without touching storage, so that series' cover objects survive with no row referencing them. |

Causes A–D are consequences of the cover contract deliberately choosing
correctness over aggressive cleanup. This sweep is the deferred other half.

---

## Grace period: 24 hours

Not a round number picked for looks — it is derived:

- A presigned PUT lives 15 minutes (`DEFAULT_PUT_URL_EXPIRY_SECONDS`), so
  bytes can never land more than 15 minutes after the intent was recorded.
  24 hours is ~96x that ceiling.
- Completion is a separate admin action taken after the upload finishes. A
  slow upload, an admin who walks away from the tab, or a retried completion
  can put hours between "bytes landed" and "cover became live".
- The operator surface is dry-run first. A window measured in hours means a
  candidate seen in one day's dry run is still a candidate the next day, so a
  human can inspect the list before deciding — a window in minutes would
  churn between inspection and decision.

**There is no environment variable that changes it.** The value is a source
constant with no `process.env` read anywhere in
`series-cover-orphan.constants.ts` (asserted by that file's spec), so no
operator, script, or misconfigured deployment can shorten it from outside the
source tree.

### The series quiet-period guard

Beyond object age, a series whose **row** was modified inside the grace
window has its entire cover namespace withheld. This is defense in depth
against the raw-key patch surface (below): a series being actively edited by
a human is never swept at the same time.

The cost is purely extra retention — a series edited daily never has its
historical covers reclaimed. That is the acceptable direction of error, and
it is reported under its own counter (`seriesRecentlyModified`) so the reason
is visible rather than hidden.

---

## Safety architecture

### Enumeration is storage-driven

Unlike `TranscodeJanitorService.cleanupOrphanStaging`, which iterates
candidate `Video` **rows** and lists each one's own prefix, this sweep pages
through the whole `admin-series/` namespace. It has to: cause E leaves an
orphan with no row to iterate from, so a row-driven sweep would never see it.

The cost of that choice is an enumeration that is unbounded in principle,
which is why it is explicitly bounded in practice.

### Bounds

| Bound | Value | Effect |
|---|---|---|
| List page size | 1000 | The S3/R2 protocol maximum — one full page per request. |
| Max pages per sweep | 100 | Hard ceiling of 100,000 objects examined per run. |
| Reported candidate detail | 500 | Bounds the printed list; **counters stay exact regardless**. |

Peak memory is one page of `{key, lastModified}` pairs plus the bounded
candidate list — never the bucket. Pages are processed and discarded one at a
time.

The loop is bounded by the page counter **first** and by the presence of a
continuation token second, so even a provider that pathologically returned a
token forever would terminate. Hitting the ceiling sets `listTruncated`,
which the CLI prints as a `WARNING` and the service logs — "we stopped early"
and "there was nothing more" are never indistinguishable.

Database queries are **two per page** (one reference lookup, one quiet-period
lookup), each with an `IN` list bounded by the page size, plus one recheck
per eligible candidate in apply mode. No query is proportional to the table.

### Two independent reference checks

1. **Page-scoped snapshot** — one query per page asking which of this page's
   keys any `Series` row currently references, through either column.
2. **Final pre-delete recheck** — immediately before each individual delete,
   the database is asked again for that one key. Enumeration and deletion are
   separated in time, so the snapshot alone is not sufficient.

Both query **by key across all series**, never scoped to the key's own parsed
`seriesId`. This matters: `UpdateSeriesDto.coverImageKey` and
`CreateSeriesDto.coverImageKey` are `@IsString() @Length(1, 500)` with no
shape validation, so an admin can point series B's cover at a key minted under
series A's prefix. A lookup scoped to the parsed id would miss it.

### Concurrency analysis

| Path | Can it race a delete? | Why not |
|---|---|---|
| `completeCoverUpload` (normal flow) | No | Completion requires `pendingCoverImageKey === key` at its final compare-and-set. While that column points at the key, the sweep sees it as `protected` and never becomes a candidate. Once it no longer points at the key, a valid completion is already impossible (`409 SERIES_COVER_KEY_SUPERSEDED`). |
| `completeCoverUpload` losing its CAS | No | The loser writes nothing at all (`resolveLostCoverCasOutcome` never writes), so it cannot resurrect a reference. |
| `PATCH { coverImageKey: null }` | No | Removes references; it can only ever make the sweep *more* conservative about what is live, never less. |
| `PATCH { coverImageKey: "<old key>" }` (raw key) | **Narrowed, not eliminated** | The only genuinely reachable path. Caught by the final recheck once committed, and additionally held off by the quiet-period guard for a full grace window. See the residual window below. |
| `POST /admin/series` with a raw `coverImageKey` | Same as above | Same surface, same two mitigations. |
| `DELETE /admin/series/:id` | No | Removes references; objects simply become eligible after grace, which is the intended behavior (cause E). |

### The one residual window

A reference created **strictly between** the recheck's read and the storage
delete is not protected. Closing it would require holding a database lock
across a network round trip to R2, which this sweep deliberately does not do.

The residual risk is bounded by: reaching the window at all requires the
raw-key PATCH/POST surface (not the normal upload flow), and the quiet-period
guard already withholds the whole cover namespace of any series touched
within the grace window. The failure mode is recoverable — a row pointing at
a missing object, fixed by re-running the normal presign + complete flow.

This limitation is **pinned by a test**
(`DOCUMENTS the one residual window this design does not close`), so a future
change that closes it fails loudly and forces this document to be updated.

---

## Running it

### Dry run (the default)

```bash
npm run maintenance:series-cover-orphans
```

Lists every candidate with its key, series, age, and reason. Removes nothing,
against any bucket — `SeriesCoverOrphanService.run` never reaches
`deleteObject` without `apply: true`, and that call sits behind a plain early
return rather than a shared "maybe delete" helper. Needs none of the gates
below, so it is safe to run anywhere for inspection.

Output prints **keys only** — never a presigned URL, endpoint, bucket
credential, or signed header.

### Apply (destructive)

```bash
NODE_ENV=development \
SERIES_COVER_ORPHAN_APPLY_BUCKET="$OBJECT_STORAGE_BUCKET" \
npm run maintenance:series-cover-orphans -- --apply
```

Both gates must pass, and both are fail-closed:

1. `NODE_ENV` is exactly `development` or `test` — an **allowlist**, so
   unset, `''`, or `produciton` are unsafe by default, never "probably fine
   because it isn't literally the word production".
2. `SERIES_COVER_ORPHAN_APPLY_BUCKET` is set to **exactly** the same value as
   `OBJECT_STORAGE_BUCKET`. This is the storage analogue of the retention
   guard's `DATABASE_URL`/`DATABASE_URL_TEST` identity check: a normal dev
   laptop has `NODE_ENV=development` while `.env` legitimately points at a
   real shared bucket, so `NODE_ENV` alone must never be sufficient.
   Requiring the operator to independently restate the bucket makes `--apply`
   impossible to trigger by ambient configuration alone.

The gate runs **before** the Nest context, `PrismaService`, or the `S3Client`
is constructed, so a refusal means zero connections and zero storage requests
happened. `SeriesCoverOrphanService.run` re-checks it as an independent
second layer.

### Not scheduled

There is **no cron registration** for this sweep — no `@Cron` decorator, no
`SchedulerRegistry` entry, no `SERIES_COVER_ORPHAN_SCHEDULE_*` variable, and
no HTTP route. `SeriesCoverOrphanCliModule` is not imported by `AppModule`, so
the service is not even instantiated during normal application boot. The CLI
is the only invocation surface.

The service is a plain injectable, so a future, separately approved work unit
*could* schedule it the way `RetentionSchedulerService` schedules retention.
That unit does not exist, and this one deliberately did not create it —
dry-run inspection comes first.

---

## Report fields

Every counter is exact and complete for the whole sweep, even when the
candidate detail list is truncated. The buckets are mutually exclusive:

```
scanned = ignoredForeignKey + protected + unknownAge + tooRecent
        + seriesRecentlyModified + eligible

eligible = deleted + failed + skippedOnRecheck     (apply)
deleted  = 0                                        (dry run, always)
```

| Field | Meaning |
|---|---|
| `scanned` | Objects returned under `admin-series/`. |
| `ignoredForeignKey` | Under the prefix but not a well-formed cover key. |
| `protected` | Referenced right now by some `coverImageKey`/`pendingCoverImageKey`. |
| `unknownAge` | Listing carried no `LastModified`; age unprovable. |
| `tooRecent` | Unreferenced but not yet past the grace window. |
| `seriesRecentlyModified` | Owning series row was touched inside the grace window. |
| `eligible` | Passed every check. |
| `deleted` | Removed from storage. Always `0` on a dry run. |
| `failed` | `deleteObject` threw. The sweep continued; nothing in the DB changed. |
| `skippedOnRecheck` | Eligible at enumeration, referenced again by the pre-delete recheck. |

Classification precedence is fixed: `protected` outranks every other bucket,
so a key that is both brand new and the live cover reports as `protected` —
the fact an operator actually needs.

---

## Failure handling and idempotency

A single object's delete failure is logged loudly, counted under `failed`, and
the sweep continues with the remaining candidates. Nothing is written to the
database at any point — there is no "deleted" column on `Series` to
desynchronize — so a failed delete simply leaves the object for the next run.

Re-running is safe: an already-removed object is no longer listed, and
`DeleteObject` is idempotent for a key that is already gone.

---

## Known limitations / follow-ups

1. **No pending-intent expiry.** An abandoned `pendingCoverImageKey` protects
   its object forever. Object cleanup and intent expiry are separate
   policies, and this slice deliberately implements only the first — deleting
   a still-referenced key to work around a long-lived intent would violate
   the primary invariant. A pending-intent expiry contract is a follow-up.
2. **The residual recheck→delete window** described above.
3. **Truncation is coverage-order dependent.** A namespace with more than
   100,000 objects is examined from the start of the prefix each run, so keys
   beyond the ceiling are only reached once earlier ones are resolved. The
   sweep reports this rather than hiding it. A per-series enumeration pass
   would be the fix if the namespace ever approaches that size.
4. **The quiet-period guard is coarse.** Any write to a `Series` row — a
   title edit, a sort-order change, an archive — defers its whole cover
   namespace by a full grace window. It is also keyed on the series named by
   the object's key PREFIX, so it does not additionally cover the case where
   a *different*, actively-edited series had adopted that key; the by-key
   reference check and the pre-delete recheck are what cover that.
5. **No index on the reference columns.** `Series.coverImageKey` and
   `Series.pendingCoverImageKey` are unindexed (the table carries only
   `@@index([sortOrder])`), so each page's reference query and each
   candidate's pre-delete recheck is a sequential scan. Irrelevant at the
   current catalog size and acceptable for a hand-run maintenance command,
   but a compound index on those two columns is the obvious fix if the table
   ever grows. Deliberately not added here: a schema migration is outside
   this slice's scope and is its own separately-approved change.
