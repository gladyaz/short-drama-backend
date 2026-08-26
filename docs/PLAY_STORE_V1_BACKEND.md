# Play Store V1 — Integrated Backend

The single reference for the merged V1 backend line
(`integration/playstore-v1-backend`), which joins the HLS/transcoding work
and the production-HTTPS work that had diverged at `27b8389`.

**Nothing described here is deployed.** Every hostname is a `<placeholder>`
the release owner fills in.

Companion documents:
- `docs/PRODUCTION_HTTPS.md` — topology, HTTPS rules, CORS, auth transport, preflight.
- `docs/PRODUCTION_DEPLOYMENT_REQUIREMENTS.md` — runtime, database, resources.
- `docs/R2_MEDIA_MIGRATION.md` — moving catalog media into object storage.
- `docs/HLS_TRANSCODE_WAVE.md` — running a controlled transcode wave.

---

## 1. Production HTTPS requirements

Under `NODE_ENV=production`, every value that becomes a URL the phone fetches
must be an absolute **https** origin that is neither loopback nor
private/LAN. The process refuses to boot otherwise, naming the variable.

| Variable | Becomes | Enforced when |
|---|---|---|
| `PUBLIC_BASE_URL` | `playbackUrl` of local-storage rows | always |
| `OBJECT_STORAGE_ENDPOINT` | origin of every presigned GET — R2 `playbackUrl` **and** every series `coverUrl` | `STORAGE_DRIVER=r2` |
| `HLS_GATEWAY_BASE_URL` | `masterUrl` + every rendition URL | `TRANSCODE_ENABLED=true` |
| `OBJECT_STORAGE_PUBLIC_BASE_URL` | `StorageService.buildPublicUrl` | when set |

`DATABASE_URL` and `REDIS_URL` are exempt — they are internal infrastructure
and never handed to a client.

Also enforced at boot: `CORS_ORIGINS` must be declared (empty is valid and
correct for a mobile-only V1), `*` is refused in every environment, and the
three auth secrets must differ from one another.

`TRUST_PROXY_HOPS` must be the real number of proxies (1 on a typical
managed platform). Never `trust proxy: true`.

## 2. HLS architecture

```
  Android ──HTTPS──> Red Panda API ──mints token──> HLS gateway (Cloudflare Worker)
                          │                              │
                          │                              └──> R2 (private)
                          └──> Postgres, R2, Redis (queue, worker only)
```

The API never transcodes. A separate worker process (`dist/worker/main`)
consumes the BullMQ queue at concurrency 1. Ladder is 360p/540p/720p with a
1080p cap; the packager writes a master playlist, per-rendition variants and
a poster thumbnail, and the package validator rejects truncated and
cross-rendition playlists before anything is promoted.

`hls:wave-enqueue` runs a dry-run-first, answerable wave. `hls:demote`
reverses a bad live generation (scoped, dry-run first).

**`TRANSCODE_ENABLED=false` is a valid V1 posture** — HLS-ready rows simply
fall back to their R2 source. No Redis, no worker, no gateway required.

## 3. Storage precedence

One rule, test-locked in `playback-source.util.spec.ts` and
`videos.service.ts`:

```
HLS (processingState=ready + hlsMasterKey)
  └─> R2 (objectStorageKey)
        └─> local (storageKey, served by this process)
              └─> 409 MEDIA_PLAYBACK_SOURCE_UNAVAILABLE
```

**A legacy `storageKey` is inert once `objectStorageKey` exists.** 15 rows
carry both; none of them depends on a developer machine. "Has a storageKey"
never means "Mac-dependent".

## 4. Current real HLS-ready catalog

Audited read-only against the shared development database:

| series | videos | R2 source-backed | HLS-ready |
|---|---|---|---|
| series-101 | 10 | 10 | 10 |
| series-104 | 10 | 5 (ep01–05) | 5 |
| series-010 | 10 | 0 | 0 |
| series-105 | 10 | 0 | 0 |
| qa fixtures | 4 | 4 | 3 |
| **total** | **44** | **19** | **18** |

Every claimed HLS master exists in R2 (18/18). One fixture
(`media-11rqa-8ac6a7f3`) claims a source object that returns NotFound —
harmless today because HLS wins for that row, but it would fail if demoted.

## 5. CONTENT_ACCESS_MODE

| Value | Behaviour |
|---|---|
| unset / `entitlement` (default) | Per-row `accessTierOverride`, else episodes ≤ 5 free. Today: **15 free, 25 premium**. |
| `free` | `resolveAccessTier` returns `free` for **every** row, including rows explicitly marked premium. |

`free` **does** override the per-row tier — deliberately, and that is the
whole point of the mode. It is not a bypass: no database value changes, the
entitlement branch stays live, the same resolver feeds both the public
`accessTier` field and the playback gate (so the client is never told a tier
the server disagrees with), and unsetting the variable restores paid
behaviour instantly.

A malformed value fails the boot rather than guessing a mode.

## 6. R2 migration status and remaining backlog

**19 of 44 rows are R2 source-backed. The true remaining backlog is 25**, all
with a real local source and zero blocked:

- `series-010`: `video-010-01 … -10` (10)
- `series-104`: `video-104-06 … -10` (5)
- `series-105`: `video-105-01 … -10` (10)

Already-linked rows are never re-counted just because a legacy `storageKey`
remains.

```
npm run media:r2-migrate                          # read-only inventory
npm run media:r2-migrate -- --only=id1,id2        # scope to exact rows
npm run media:r2-migrate -- --only=… --upload     # write (needs R2_MEDIA_MIGRATION_APPLY_BUCKET)
```

**Not all 25 must migrate before first release.** What must be playable is
what a V1 user can reach. With `CONTENT_ACCESS_MODE` at its default, that is
the 15 free episodes — 10 of which are already R2/HLS-backed. Set the mode to
`free` and the whole visible catalog becomes reachable, which raises the bar
to all 40 drama rows. Decide the mode first; it changes the content scope.

## 7. Fixture-content rule

`contentKind` separates catalog content from internal fixtures.

- **Listing routes exclude fixtures server-side**: `GET /videos/feed`,
  `GET /series`, `GET /series/:id` episodes.
- **Direct-addressing routes still serve them**: `GET /videos/:id`,
  `/videos/:id/playback`, `/videos/:id/stream` — internal tooling depends on
  this (`hls:real-media-proof` exercises `/videos/:id/playback` against
  seeded fixture rows).

Fixture rows are never deleted. Before this integration the feed did not
filter, so 4 published fixtures reached ordinary viewers as episodes.

## 8. Auth and monetisation

| Flow | Status |
|---|---|
| Email / password | **READY IN CODE.** No flag, no external dependency. |
| Google | **READY IN CODE, NEEDS EXTERNAL CONFIG.** Real JWKS verifier. Needs `GOOGLE_AUTH_ENABLED=true` + `GOOGLE_OAUTH_CLIENT_IDS`, an OAuth client for `com.spark.redpanda`, and the **Play App Signing SHA-1**. No client secret is required or ever read. |
| WhatsApp | **NOT IMPLEMENTED.** Only the `fake` driver exists; boot refuses it outside dev/test, so it cannot be enabled in production at all. |
| Payments | **OUT OF V1.** `PAYMENTS_ENABLED=false`; `/payments/*` answers 503. |
| Ads (AdMob) | External. Owner supplies the AdMob app id and unit ids to the mobile app; the backend only serves pacing config via `GET /config/ads`. |

## 9. Health and preflight

| Route | Auth | Touches |
|---|---|---|
| `GET /health` | none | nothing (**liveness**) |
| `GET /health/ready` | none | one `SELECT 1` (**readiness**, 200/503) |
| `GET /health/details` | `DEV_TOOLS_ENABLED` | DB + config — unreachable in production |

```
npm run production:preflight                       # before deploy, read-only
API_BASE_URL=https://<origin> npm run smoke:production   # after deploy
```

The preflight reports `PASS`/`WARNING`/`BLOCKER`, exits non-zero on blockers,
prints no secret, and reports the integrated postures — `CONTENT_ACCESS_MODE`
and whether the HLS pipeline is on.

## 10. Remaining before release

Code is not the blocker. What remains is owner/external:

1. Production domain, DNS, TLS host; production Postgres; R2 credentials.
2. Three independently generated auth secrets.
3. Google OAuth client + Play App Signing SHA-1.
4. AdMob ids; privacy-policy and account-deletion URLs.
5. Decide `CONTENT_ACCESS_MODE`, then migrate the content that decision makes
   user-visible.
6. **Physical Android device HLS QA** — paused while the device is
   unavailable. Real-device playback of an HLS-ready episode
   (`series-101`/`series-104` ep01–05) over the production gateway has not
   yet been observed; every HLS proof so far is server-side.
