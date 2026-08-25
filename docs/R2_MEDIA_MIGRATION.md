# R2 Media Migration Runbook

Moving the 40 published episodes whose media exists only on a local
filesystem into object storage, so a guest on a Play Store install can stream
them over the public internet.

**Nothing in this repository runs this automatically.** There is no cron, no
scheduler registration, no CI step and no application boot path that reaches
`R2MediaMigrationService`. A human types every command below.

---

## 1. Why `STORAGE_DRIVER=r2` is not enough

Playback source is decided **per row**, by `resolvePlaybackSource`
(`src/videos/playback-source.util.ts`), in this order:

1. `hlsMasterKey` set and the row is fully processed → HLS gateway
2. `objectStorageKey` set → presigned R2 GET URL
3. `storageKey` set → `${PUBLIC_BASE_URL}/videos/:id/stream`, served off
   `STORAGE_ROOT` **by the Node process**
4. neither → `409 MEDIA_PLAYBACK_SOURCE_UNAVAILABLE`

`STORAGE_DRIVER` selects how R2 rows are *served*. It moves no bytes and sets
no column. A row at step 3 stays at step 3 forever until something writes its
`objectStorageKey` — and on a container, step 3 reads an empty directory.

Current state (from `npm run media:r2-migrate`):

| | |
|---|---|
| Published rows | 42 |
| Already on object storage | 2 (both `contentKind: qa_fixture`) |
| **Local-filesystem only** | **40** |
| Source directory | `/Users/gladyaz/dracin-subsindo` (this machine's `STORAGE_ROOT`) |
| Total bytes to move | ~0.72 GiB (mean 18.5 MiB, largest 44.7 MiB) |

## 2. The mapping

```
Video row  ──id──▶  objectStorageKey = admin-media/<id>/source
    │
    └──storageKey──▶  ${STORAGE_ROOT}/<storageKey>   (the local source file)
```

**The destination key is derived from the primary key, never from the
filename.** Three reasons, all load-bearing:

1. **Uniqueness is structural.** `Video.id` is the primary key, so two rows
   cannot collide. A filename-derived scheme *would*: `Series 104/1_subtitled.mp4`
   and `Series-105/1_subtitled.mp4` share a basename, and this catalog
   contains that collision four times over.
2. **It is ASCII-safe.** `series-101`'s episodes are named
   `第1集_subtitled.mp4` … `第10集_subtitled.mp4`. Those bytes would work in an
   object key, but every later `curl`, log line and bucket-console URL would
   carry percent-encoded CJK forever.
3. **It matches what exists.** The two QA-fixture rows already use
   `admin-media/<id>/source`, written by the admin upload flow.

The original filename is not lost — `storageKey` still holds it, and this
migration never writes to that column.

**Source paths are never guessed.** Each comes from that row's own
`storageKey`, resolved through the same `resolveSafeStoragePath` the streaming
endpoint uses. This matters concretely: the source directories hold **277**
`_subtitled.mp4` files against **40** catalogued rows, so a directory glob
would upload 237 files no row references.

## 3. Safety properties

Enforced by construction, not by operator discipline:

| Property | How |
|---|---|
| Read-only by default | `inventory` is the default mode; writing modes need an explicit flag |
| Writing needs a restated bucket | `R2_MEDIA_MIGRATION_APPLY_BUCKET` must equal `OBJECT_STORAGE_BUCKET` |
| Never overwrites a link | Selection predicate is `objectStorageKey IS NULL`; the write is an `updateMany` carrying that same predicate (compare-and-set) |
| QA fixtures untouched | Both already have an `objectStorageKey`, so the same predicate excludes them |
| Local files never modified | The service has no unlink, rename, or write path to `STORAGE_ROOT` |
| DB only ever points at verified objects | `--link` re-HEADs each object *in the same run* immediately before writing, and compares byte length |
| Restartable | `--upload` skips destinations already present at the right size; `--link` skips already-linked rows |
| One bad row cannot abort a batch | Row-level problems become reported `blockedReason`s, not exceptions |
| Bounded | `--limit` defaults to 200 and warns if it truncates |

## 4. Procedure

### Step 1 — Inventory (read-only, safe anywhere, anytime)

```
npm run media:r2-migrate
```

Writes nothing to the bucket or the database — it does not even contact R2.
Prints the exact mapping it *would* apply and names every unresolvable row.
**`blocked=0` is the precondition for step 2.**

Add `--check-remote` to also HEAD each destination key (one read-only call per
row; needs working credentials):

```
npm run media:r2-migrate -- --check-remote
```

### Step 2 — Upload (writes to the bucket, not the database)

```
R2_MEDIA_MIGRATION_APPLY_BUCKET="$OBJECT_STORAGE_BUCKET" \
npm run media:r2-migrate -- --upload
```

Requires `STORAGE_DRIVER=r2`, a configured bucket, and the restatement above.
Uploads each ready row as `video/mp4`, skipping any destination already
present at the correct size — so an interrupted run is resumed by re-running
the identical command. A destination present at the *wrong* size is
re-uploaded: that is a failed previous attempt, and `PutObject` replaces the
object atomically.

### Step 3 — Verify (read-only)

```
npm run media:r2-migrate -- --verify
```

HEADs every destination and compares byte length against the local source.
**`mismatch=0` is the precondition for step 4.** A present-but-wrong-size
object is exactly what a truncated upload looks like, and is precisely what
must never be linked into the catalog.

### Step 4 — Link (the only step that writes to the database)

```
R2_MEDIA_MIGRATION_APPLY_BUCKET="$OBJECT_STORAGE_BUCKET" \
npm run media:r2-migrate -- --link
```

Re-confirms each object by HEAD in the same run, then sets that row's
`objectStorageKey`. Skips and reports any row whose object is absent or the
wrong size. Never overwrites an existing value.

### Step 5 — Prove it end to end

```
API_BASE_URL=https://<origin> npm run smoke:production
```

Must report `media object serves bytes` — that is the check that distinguishes
"the API is up" from "a guest can actually watch something".

## 5. Rollback

The migration is additive and reversible, because nothing is destroyed:

- **Local files are never touched**, so `STORAGE_DRIVER=local` restores the
  previous behavior immediately on any machine that has them.
- To un-link a row, clear its `objectStorageKey`; `resolvePlaybackSource`
  falls back to `storageKey` on the very next request.
- Uploaded objects can be left in place — an unreferenced object costs storage
  and nothing else. This tool has no delete mode by design.

## 6. Exit status

`0` — everything resolved and every requested action succeeded.
`1` — blocked rows, a verification mismatch, a refused gate, or a bad argument.

Non-zero on "reported 12 missing source files" is deliberate: a `&&` chain or
CI step must not read a report full of problems as success.
