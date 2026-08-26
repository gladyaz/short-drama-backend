# HLS Transcode Wave Runbook

Turning existing catalog episodes into multi-rendition HLS, five at a time.

**Nothing in this repository runs this automatically.** `TRANSCODE_ENABLED`
defaults to `false`, which is the only state this repo ships. With the flag
off, `TranscodeModule` provides the inert `NoopTranscodeQueueClient`, the
janitor's sweeps return `0` before issuing a single query, and
`node dist/worker/main` boots, logs a readiness line and exits. A human types
every command below.

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

`TRANSCODE_WORKER_CONCURRENCY` is `1`, so a five-episode wave transcodes
**serially**, never in parallel — by design, so ffmpeg never starves the API.

### Trigger

```bash
# Producer. Preflight-only first — writes nothing, enqueues nothing:
TRANSCODE_ENABLED=true npm run hls:wave-enqueue -- --ids=<id1>,...,<id5> --dry-run

# Then for real:
TRANSCODE_ENABLED=true npm run hls:wave-enqueue -- --ids=<id1>,...,<id5>

# Consumer, in a second terminal (or under pm2/systemd):
npm run build && TRANSCODE_ENABLED=true node dist/worker/main
```

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

The script exits non-zero unless every requested id was enqueued, so its exit
code is usable as a gate without parsing its JSON.

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
`POSTER_GENERATION_FAILED`, `MAX_ATTEMPTS_EXCEEDED`, `STALE`.

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

## 8. Rolling back

**A bad generation cannot become live in the first place.** Promotion happens
only after every rung transcoded, the package validated locally, and every
uploaded key was HEAD-verified. Anything short of that cleans up its own
staging and leaves `hlsMasterKey` pointing at the previous good generation
(or `null`).

Superseded generations are reclaimed automatically by
`TranscodeJanitorService.cleanupOrphanStaging`, which never deletes the active
prefix and never deletes anything newer than
`TRANSCODE_CLEANUP_GRACE_MINUTES` (default 120), so an in-flight player
holding a token is never cut off.

> **Gap — no rollback command exists.** `promoteIfCurrent` is the *only*
> writer of `hlsMasterKey` in the codebase, and there is no tool to demote a
> generation that promoted successfully but is later judged bad (wrong crop,
> bad audio sync). Reverting one today means a manual `Video` write to reset
> `hlsMasterKey`/`hlsRenditions`/`processingState`, after which playback falls
> back to the R2/local branch. Worth building before a large wave; not
> blocking for five episodes.

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
  live pointer, and each attempt cleans up exactly the keys it wrote.

Run the wave on **one episode first**, verify §9 end to end, and only then
queue the remaining four. Concurrency is 1 so the wave is serial regardless —
there is no throughput cost to proving the first one properly.

Not proven here, and out of scope for this runbook: playback on a physical
Android device. Every HLS result referenced above is backend/manifest-level.
