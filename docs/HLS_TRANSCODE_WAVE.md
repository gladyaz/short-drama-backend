# HLS Transcode Wave Runbook

Turning existing catalog episodes into multi-rendition HLS, five at a time.

**Nothing in this repository runs this automatically.** `TRANSCODE_ENABLED`
defaults to `false`, which is the only state this repo ships. With the flag
off, `TranscodeModule` provides the inert `NoopTranscodeQueueClient`, the
janitor's sweeps return `0` before issuing a single query, and
`node dist/worker/main` boots, logs a readiness line and exits. A human types
every command below.

---

## 0. The operator sequence

Run these in order. **Every command that mutates anything is marked MUTATES;
everything else is read-only and safe to run against any environment.** No
command below does anything unless a human types it.

| # | Step | Command | Writes? |
|---|---|---|---|
| 1 | PRE-FLIGHT | `TRANSCODE_ENABLED=true npm run hls:wave-enqueue -- --ids=<id> --dry-run` | read-only |
| 2 | DRY RUN (all five) | `TRANSCODE_ENABLED=true npm run hls:wave-enqueue -- --ids=<id1>,…,<id5> --dry-run` | read-only |
| 3 | SINGLE EPISODE | `TRANSCODE_ENABLED=true npm run hls:wave-enqueue -- --ids=<id1>` | **MUTATES** (DB + queue) |
| 4 | VERIFY | `curl -s "$PUBLIC_BASE_URL/videos/<id1>/playback" \| jq` | read-only |
| 5a | ROLLBACK dry run | `npm run hls:demote -- --video-id <id1> --generation <n>` | read-only |
| 5b | ROLLBACK apply | `npm run hls:demote -- --video-id <id1> --generation <n> --apply` | **MUTATES** (DB only) |
| 6 | FIVE-VIDEO WAVE | `TRANSCODE_ENABLED=true npm run hls:wave-enqueue -- --ids=<id1>,…,<id5>` | **MUTATES** (DB + queue) |

Step 5 only runs if step 4 shows something wrong. Steps 1-2 and 5a are the
same commands as steps 3 and 5b with one flag removed:

- `hls:wave-enqueue` mutates **unless** `--dry-run` is present.
- `hls:demote` is read-only **unless** `--apply` is present.

Both dry runs exit non-zero if they would not do what you asked, so either one
can gate a script without parsing its output.

The consumer (`node dist/worker/main`) must be running in another terminal for
steps 3 and 6 to make progress; it is not needed for any other step.

---

## 1. What runs, and in what order

The pipeline is deliberately split into a **producer** and a **consumer**,
which are separate processes:

```
scripts/hls-wave-enqueue.ts          node dist/worker/main
  (producer — you run this)            (consumer — long-running)
        │                                       │
        │ DB write: processingVersion++         │ BullMQ delivery
        │ processingState = "queued"            ▼
        └────── BullMQ ── Redis ──────▶ TranscodeJobProcessor.process()
                                                │
              download source ─▶ ffprobe ─▶ ladder ─▶ ffmpeg × N rungs
                    ─▶ master.m3u8 ─▶ upload to a fresh staging prefix
                    ─▶ validate locally ─▶ HEAD-verify every uploaded key
                    ─▶ poster (if none) ─▶ promoteIfCurrent()  ← the only flip
```

Worker concurrency **defaults to `1`**, so a five-episode wave transcodes
**serially**, never in parallel — by design, so ffmpeg never starves the API.
It is now an operator-set value (`TRANSCODE_WORKER_CONCURRENCY`) rather than a
compile-time constant; on a dedicated VPS it may be raised deliberately after
measurement. See `docs/TRANSCODE_WORKER_VPS.md` ("Concurrency sizing").

### Trigger

```bash
# Producer, DRY RUN — read-only. Zero DB writes, zero BullMQ writes, zero
# object-storage writes. Exits non-zero unless EVERY id would be enqueued:
TRANSCODE_ENABLED=true npm run hls:wave-enqueue -- --ids=<id1>,...,<id5> --dry-run

# Producer, FOR REAL — MUTATES. Drop --dry-run and nothing else changes:
TRANSCODE_ENABLED=true npm run hls:wave-enqueue -- --ids=<id1>,...,<id5>

# Consumer, in a second terminal (or under pm2/systemd):
npm run build && TRANSCODE_ENABLED=true node dist/worker/main
```

`--dry-run` is the ONLY difference between the read-only form and the
mutating form. There is no interactive confirmation — if the flag is absent,
the command enqueues.

`TRANSCODE_ENABLED` must be exactly `"true"`. Both scripts refuse to start
otherwise rather than silently enqueueing into a no-op queue.

---

## 2. Preflight — all five must pass, per episode

`hls-wave-enqueue.ts` checks each id independently; a failure **skips only
that episode**, never the wave, and always prints the reason.

| Check | Skip reason emitted |
|---|---|
| Row exists and `lifecycleState = "published"` | `ROW_NOT_FOUND` / `NOT_PUBLISHED (<state>)` |
| `width`/`height` recorded on the row | `DIMENSIONS_UNKNOWN — cannot prove portrait` |
| Portrait (`width < height`) | `NOT_PORTRAIT (<w>x<h>)` |
| Source object present and non-empty at `admin-media/<id>/source` | `SOURCE_MISSING` / `SOURCE_EMPTY` |
| Not already `queued`/`running` | `ALREADY_IN_FLIGHT (<state>)` |

The script exits non-zero unless every requested id was enqueued — and under
`--dry-run`, unless every requested id **would** be enqueued — so its exit code
is usable as a gate without parsing its JSON.

### What the dry run prints, per candidate

| Field | Meaning |
|---|---|
| `videoId` | the id as given |
| `wouldEnqueue` | the answer you are actually asking for. `enqueued` is always `false` in a dry run |
| `reason` | why it was skipped, or `DRY_RUN (all preflight checks passed …)` |
| `sourceKey` | `admin-media/<id>/source` — printed even for `ROW_NOT_FOUND`, since it is a pure function of the id |
| `sourceExpectation` | `present and non-empty (HEAD verified)`, `present but ZERO bytes`, or `absent — run the R2 media migration for this row first` |
| `sourceBytes` | the HEAD's `contentLength` |
| `width`/`height` | the recorded catalog dimensions the portrait gate judged |
| `expectedLadder` | the rungs those dimensions imply, e.g. `["360p 360x640", "540p 540x960"]` |
| `expectedLadderCaveat` | why that is a preview and not a promise (see below) |
| `writes` | `{database: 0, bullmq: 0, objectStorage: 0}` — stated explicitly in the JSON |

`expectedLadder` is computed by running the real `computeRenditionLadder` over
the row's **recorded** `width`/`height`. The worker re-probes the source and
ladders on the **probed, post-rotation** dimensions, which is the only
authority. A row whose recorded dimensions disagree with its file, or whose
file carries display rotation, will produce a different ladder. Treat it as a
sanity check ("does 720x1280 really imply three rungs?"), never as a
guarantee.

### Two blockers that will bite a first wave

1. **The source must already be in object storage.** The worker downloads
   `admin-media/<id>/source`; it never reads `STORAGE_ROOT`. Any row that is
   still local-filesystem-only fails preflight with `SOURCE_MISSING`. Run
   [`R2_MEDIA_MIGRATION.md`](./R2_MEDIA_MIGRATION.md) for those rows **first**.
2. **Landscape rows are refused outright.** The wave is scoped to portrait
   media and will not quietly widen. Landscape episodes need either a
   deliberate change to that gate or a separate, explicitly-approved wave.
   (The ladder itself handles landscape correctly — see
   `rendition-ladder.spec.ts`; only the wave script's scope gate refuses it.)

---

## 3. Expected output keys

Every attempt writes to a **fresh, immutable, unique** prefix. Nothing is ever
overwritten, and the currently-live generation is never touched:

```
admin-media/<id>/hls/v<processingVersion>-a<attempt>-<uuid>/
  master.m3u8
  360p/index.m3u8   360p/init.mp4   360p/seg_00000.m4s  …
  540p/…   720p/…   1080p/…            (only the rungs the source supports)
admin-media/<id>/thumbnail             (only if the row had no poster)
```

Which rungs appear is decided by the source's **post-rotation short side**:
`≥1080 → 4 rungs`, `≥720 → 3`, `≥540 → 2`, `≥360 → 1`, `<360 → one degenerate
rung at source size`. The ladder never upscales.

---

## 4. Expected DB state changes

On `Video`, in pipeline order:

| Column | Becomes |
|---|---|
| `processingVersion` | incremented (atomic; two racing calls get distinct versions) |
| `processingState` | `queued` → `running` → `ready` (or `failed`) |
| `processingAttempts` | reset to 0 at enqueue, incremented on each claim |
| `processingStartedAt` | set on claim |
| `processingStep` | `probing` → `360p` → … → `packaging` → `uploading` → `verifying` → `poster` → `null` |
| `sourceWidth` / `sourceHeight` / `sourceDurationSeconds` / `sourceFps` | probed values (telemetry only) |
| `thumbnailImageKey` | generated poster key — only if it was `null` |
| `hlsMasterKey` | the new `master.m3u8` key — **written only by `promoteIfCurrent`** |
| `hlsRenditions` | JSON array of **only the renditions actually produced** |
| `transcodeProfileVersion` | `"ladder-v1"` |
| `processingCompletedAt` | set on terminal outcome |
| `processingErrorCode` / `processingErrorMessage` | set on failure; bounded and secret-redacted |

`hlsMasterKey`, `hlsRenditions` and `transcodeProfileVersion` are written in a
**single guarded `updateMany`** that requires `(id, expectedVersion,
state="running")`. A superseded or already-flipped row matches zero rows and
**nothing is written** — the previous generation stays live.

---

## 5. Observing progress

```sql
SELECT id, "processingState", "processingStep", "processingAttempts",
       "processingErrorCode", "hlsMasterKey"
FROM "Video" WHERE id IN (...) ORDER BY id;
```

`processingStep` is the live progress field — it names the rung currently
encoding. The worker also logs an accepted line per job and a promoted line
with rendition count and wall-clock.

---

## 6. Detecting failure

`processingState = 'failed'` plus a `processingErrorCode` from the closed set:
`SOURCE_MISSING`, `PROBE_FAILED`, `TRANSCODE_FAILED`, `UPLOAD_FAILED`,
`HLS_PACKAGE_VALIDATION_FAILED`, `UPLOAD_VERIFICATION_FAILED`,
`POSTER_GENERATION_FAILED`, `MAX_ATTEMPTS_EXCEEDED`, `STALE`, `DEMOTED`.

`DEMOTED` is the one member of that set that is not a pipeline failure: it
means an operator ran `hls:demote --apply` against a generation that had
promoted successfully (§8). Its artifacts were not deleted.

A row stuck `running` past `TRANSCODE_STALLED_AFTER_MINUTES` (default 30) is
CAS-failed as `STALE` by `TranscodeJanitorService.sweepStaleRunning`, which the
worker runs every `TRANSCODE_JANITOR_INTERVAL_MS` (5 min) in persistent mode.

**A partial ladder is never packaged or promoted.** If any single rung's ffmpeg
call fails, the whole job fails; no master playlist is built, nothing is
promoted, and every key that attempt uploaded is deleted by exact key.

---

## 7. Retrying safely

Re-run `hls:wave-enqueue` with the same ids. This bumps `processingVersion`,
which:

- gives the retry a brand-new staging prefix (no collision with the failed
  attempt's objects);
- makes every CAS from the *old* generation match zero rows, so a late worker
  still finishing the superseded attempt cannot write anything; and
- clears `processingStep`/`processingAttempts`/error columns for the fresh
  generation.

Retries within one generation are bounded by `TRANSCODE_MAX_ATTEMPTS`
(default 3) with exponential BullMQ backoff (~1 m → 5 m → 25 m). The last
permitted attempt fails **terminally** with its real error code rather than
burning a cycle on `MAX_ATTEMPTS_EXCEEDED`.

---

## 8. Rolling back — `npm run hls:demote`

### A bad generation cannot become live by accident

Promotion happens only after every rung transcoded, the package validated
locally, and every uploaded key was HEAD-verified. Anything short of that
cleans up its own staging and leaves `hlsMasterKey` pointing at the previous
good generation (or `null`).

Superseded generations are reclaimed automatically by
`TranscodeJanitorService.cleanupOrphanStaging`, which never deletes the active
prefix and never deletes anything newer than `TRANSCODE_CLEANUP_GRACE_MINUTES`
(default 120), so an in-flight player holding a token is never cut off.

This section is about the other case: a generation that promoted **correctly**
and was only later judged bad — wrong crop, bad audio sync, wrong source file.

### There is no rollback-to-previous, and there cannot be one today

`TranscodeIntentService.promoteIfCurrent` overwrites `hlsMasterKey`,
`hlsRenditions` and `transcodeProfileVersion` **in place**, and it is the only
writer of those columns in the codebase. **No table, column, or audit row
anywhere in this schema records what the pointer used to be.** Once a
generation promotes, its predecessor's identity is gone from the database; the
predecessor's *objects* survive in R2 only until the janitor's grace window
elapses.

So the command that exists is a **DEMOTE**, not a rollback. It stops the row
advertising the bad generation and lets playback fall back through the
existing, unchanged R2/local resolution. It restores nothing.

### The command

```bash
# DRY RUN — the default. Read-only. Prints the current row state, the exact
# master key and generation prefix that would stop being advertised, the
# renditions that go with them, the objects it will not touch, and what
# /playback would answer afterwards:
npm run hls:demote -- --video-id video-101-01 --generation 1

# MUTATES — one guarded UPDATE. Storage is still never touched:
npm run hls:demote -- --video-id video-101-01 --generation 1 --apply
```

`--generation` is the row's **current `processingVersion`** — the same integer
that appears in the generation prefix (`.../hls/v1-a1-<uuid>/`) and in the
BullMQ job id (`<videoId>__v1`). Read it, do not guess it:

```sql
SELECT id, "processingState", "processingVersion", "hlsMasterKey"
FROM "Video" WHERE id = 'video-101-01';
```

`--apply` is the only difference between the two forms. There is no
interactive confirmation. Deliberately **not** gated on `TRANSCODE_ENABLED`:
"turn the pipeline off and stop advertising its output" is exactly the
situation this command exists for, and it touches no queue.

`--help` prints the full usage and exits 0.

### Safety gates — every one of these writes NOTHING and exits 1

| Refusal | Means |
|---|---|
| `ROW_NOT_FOUND` | no `Video` row with that id |
| `NOT_AN_HLS_PIPELINE_ROW` | `processingState IS NULL` — a legacy/local row the pipeline never touched |
| `GENERATION_MISMATCH` | `--generation` ≠ the row's current `processingVersion`. **A stale command can never demote the generation that superseded it.** |
| `NO_ACTIVE_HLS_GENERATION` | `hlsMasterKey IS NULL` — nothing is advertised. Also the answer to a repeated demote |
| `NOT_READY` | the row is `queued`/`running`/`failed`. While it is not `ready` it is **not advertising HLS at all**, and a row mid-flight must not be demoted out from under its worker |
| `GENERATION_POINTER_MISMATCH` | the live pointer's prefix does not carry `v<generation>-`; the column and the key disagree |
| `MASTER_KEY_FOREIGN` | the pointer does not live under this video's own `admin-media/<id>/hls/` home |
| `NO_PLAYBACK_FALLBACK` | demoting would leave the row with no playable source, or its source object is missing from storage. Override with `--allow-unplayable` |
| `CAS_LOST` | the row changed between the read and the write. Nothing was modified — re-run the dry run |

The command also refuses, before opening a database connection at all, a
`--video-id` that is not a plain id: no wildcards, no slashes, no
percent-escapes, no whitespace. It addresses exactly one row by primary key.

### What `--apply` writes

One `updateMany`, guarded on **all four** of `(id, processingVersion,
processingState = "ready", hlsMasterKey)` — naming the pointer *value* in the
WHERE clause, not just the version, is what makes a stale command structurally
incapable of demoting a generation it did not name:

| Column | Becomes |
|---|---|
| `hlsMasterKey` | `NULL` |
| `hlsRenditions` | SQL `NULL` |
| `transcodeProfileVersion` | `NULL` |
| `processingState` | `failed` |
| `processingStep` | `NULL` |
| `processingErrorCode` | `DEMOTED` |
| `processingErrorMessage` | which generation was demoted, and that storage was kept — an audit trail, not restorable state |
| `processingCompletedAt` | now |

Untouched: `processingVersion`, `lifecycleState`, `objectStorageKey`,
`storageKey`, `thumbnailImageKey`, every other row, and **every object in
storage**.

### Storage policy — nothing is deleted, deliberately

The demote makes **zero** delete calls, zero list calls and zero writes to
object storage. Its only storage call is a read-only `HEAD` of the fallback
source object. Three reasons, in order of weight:

1. **Playback tokens are stateless.** The gateway validates an HMAC and never
   consults the database, so a token minted a minute before the demotion stays
   valid until it expires. Deleting the objects immediately would 404 a viewer
   mid-episode; leaving them lets those grants drain naturally.
2. **A demote that deletes is unrecoverable.** A demote that only stops
   advertising can be undone by re-transcoding; one that deleted the artifacts
   also destroyed the evidence of what was wrong with them.
3. **Deletion already has an owner.** `cleanupOrphanStaging` reclaims
   non-active prefixes on a schedule, with a grace window and an exact-key
   delete. A second deletion path would be a second thing to get wrong.

### Limitations — read these before relying on the command

1. **Nothing is restored.** Recovery from a demotion is a fresh transcode
   (`hls:wave-enqueue` on that id), which bumps `processingVersion` and builds
   a brand-new generation. There is no "re-promote the old one".
2. **Already-minted playback tokens keep working** until they expire
   (`HLS_TOKEN_TTL_SECONDS`, default 3600 = 1 hour). The demotion stops *new*
   grants; it cannot revoke issued ones. Plan for up to one TTL of residual
   playback on the bad generation.
3. **The demoted generation becomes janitor-eligible immediately.** Once
   `hlsMasterKey` is `NULL`, that prefix is no longer "active", and
   `cleanupOrphanStaging` deletes any non-active prefix whose newest object is
   older than `TRANSCODE_CLEANUP_GRACE_MINUTES` (default 120). For a
   generation promoted more than two hours ago that is *already* true, so a
   worker running with `TRANSCODE_ENABLED=true` will delete those objects on
   its next sweep (every 5 minutes). **If you need the bad generation for
   forensics, copy the prefix first** — the dry run prints it verbatim.
4. **`lifecycleState` is untouched.** The row stays `published` and serves its
   source MP4. Taking it out of the catalog entirely is a separate admin
   unpublish. Note that while `processingState = "failed"`,
   `AdminMediaService`'s publish gate will refuse a *future* publish
   transition of that row until a new generation promotes.
5. **A row with no MP4 fallback becomes unplayable** (409
   `MEDIA_PLAYBACK_SOURCE_UNAVAILABLE`). The command refuses that case by
   default; `--allow-unplayable` is how you accept it deliberately.

### What playback answers afterwards

Whatever `resolvePlaybackSource` already says for that row — this command adds
no new fallback of its own:

| Row | `GET /videos/:id/playback` after the demotion |
|---|---|
| `objectStorageKey` set | presigned R2 URL for the source MP4 (`type` absent, legacy shape) |
| local-only (`storageKey` set) | `<PUBLIC_BASE_URL>/videos/<id>/stream` |
| neither | 409 `MEDIA_PLAYBACK_SOURCE_UNAVAILABLE` |

The dry run computes and prints this per row before you act, including whether
the fallback object really exists in storage. It is proven end to end in
`hls-demote-playback.spec.ts`, which calls the real `VideosService` before and
after a real demotion.

---

## 9. Verifying afterwards

```bash
curl -s "$PUBLIC_BASE_URL/videos/<id>/playback" | jq
```

A promoted row answers with the HLS shape — never the legacy three-key shape:

```json
{
  "type": "hls",
  "masterUrl": "<HLS_GATEWAY_BASE_URL>/t/<token>/master.m3u8",
  "renditions": [
    { "quality": "360p",  "width": 360,  "height": 640,  "url": ".../360p/index.m3u8" },
    { "quality": "540p",  "width": 540,  "height": 960,  "url": ".../540p/index.m3u8" },
    { "quality": "720p",  "width": 720,  "height": 1280, "url": ".../720p/index.m3u8" },
    { "quality": "1080p", "width": 1080, "height": 1920, "url": ".../1080p/index.m3u8" }
  ],
  "expiresAt": "…"
}
```

Check, in order:

1. `renditions` lists **exactly** the rungs the source supports — a 720p source
   must not advertise 1080p.
2. Every rendition URL carries the **same** token as `masterUrl` (one grant
   covers the master, every variant playlist and every segment under the
   generation prefix).
3. `expiresAt` is in the future (`HLS_TOKEN_TTL_SECONDS`, default 3600).
4. The manifests actually play. `ffmpeg -v error -i "<masterUrl>" -f null -`
   is the fastest independent check.

---

## 10. Is it safe to run on five videos?

**Yes, once the two preflight blockers in §2 are cleared**, given what is
already proven:

- the ladder emits four rungs from a ≥1080-short-side source, caps a 4K source
  at 1080p, and never upscales (`rendition-ladder.spec.ts`);
- the real pipeline produces and validates all four rungs from a 1080×1920
  source, and also survives no-audio, odd-dimension, 59.94 fps and sub-360p
  sources (`npm run hls:local-proof`);
- a partial ladder never promotes, a superseded generation can never flip the
  live pointer, and each attempt cleans up exactly the keys it wrote;
- and a generation that promotes correctly but turns out to be bad can now be
  taken out of playback with one scoped, dry-run-by-default command (§8),
  without touching storage or any other row.

Run the wave on **one episode first**, verify §9 end to end, and only then
queue the remaining four. Concurrency is 1 so the wave is serial regardless —
there is no throughput cost to proving the first one properly.

The one residual exposure to plan around is §8's limitation 2: a demotion
cannot revoke playback tokens that were already minted, so a bad generation
stays reachable to clients holding one for up to `HLS_TOKEN_TTL_SECONDS`
(default 1 hour).

Not proven here, and out of scope for this runbook: playback on a physical
Android device. Every HLS result referenced above is backend/manifest-level.
