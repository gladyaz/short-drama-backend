# Production Deployment Requirements

The runtime this backend actually needs, derived from the code rather than
from a provider's template. **No provider is chosen here** and no value below
is invented — anything this repository cannot know (a hostname, a bucket
name, a credential) is written as a blank the release owner fills in.

Companion documents:
- `docs/PRODUCTION_HTTPS.md` — topology, HTTPS rules, CORS, auth transport, preflight.
- `.env.production.example` — the environment contract, name by name.
- `docs/R2_MEDIA_MIGRATION.md` — moving the catalog's media into object storage.
- `docs/r2-readiness.md` — credential insertion and the disposable-object smoke test.

---

## 1. Runtime

| | |
|---|---|
| Language / framework | TypeScript 5.7, NestJS 11 on Express 5 |
| **Node** | **`>=22.0.0 <25.0.0`** (`package.json` `engines`); `.nvmrc` pins **22**, the version CI proves every commit against |
| Package manager | npm, `npm ci` against the committed `package-lock.json` |
| Process model | One long-lived HTTP process. **Single-instance for V1** — see §7. |

## 2. Build and start

```
Install:  npm ci
Generate: npx prisma generate     # REQUIRED — @prisma/client is generated, not vendored
Build:    npm run build           # nest build -> dist/
Start:    npm run start:migrate:prod
```

`start:migrate:prod` is `prisma migrate deploy && node dist/main`. Split them
if the platform offers a distinct release phase; run migrations exactly once
per release either way.

`npx prisma generate` is not optional. Skipping it fails the build, because
nothing in the repo imports a pre-generated client.

## 3. Listening and health

| | |
|---|---|
| Port | `process.env.PORT`, default `3000`. Read it — do not hardcode. |
| Bind address | `0.0.0.0` (hardcoded in `src/main.ts`) — correct for a container. |
| **Liveness probe** | **`GET /health`** → `200 {"status":"ok","service":"short-drama-backend"}` |
| **Readiness probe** | **`GET /health/ready`** → `200 {"status":"ready","database":"ok"}` / `503 {"status":"not_ready","database":"unreachable"}` |
| Auth on either | None. Both are safe as platform probes. |

`GET /health` is **liveness**: it touches nothing — no database, no storage,
no Redis — so it answers 200 while Postgres is down. That is deliberate. A
liveness probe that failed on a dependency outage would tell the platform to
**restart** the container, which cannot fix a database and turns a
recoverable outage into a crash loop.

`GET /health/ready` is **readiness**: one `SELECT 1`, no side effects, and a
503 when the database is unreachable, so a platform can hold traffic off an
instance instead of serving 500s from it. It reports a closed two-field
shape — no hostname, connection string, driver name, error text or stack.
Only the database is checked: presigned URLs are signed offline and Redis is
only connected when `TRANSCODE_ENABLED=true`, which V1 does not ship.

The full operator view (`GET /health/details`) remains gated behind
`DEV_TOOLS_ENABLED`, which must be `false` in production, so it is
deliberately unreachable there.

Graceful shutdown is wired (`app.enableShutdownHooks()`), so **SIGTERM is
handled**: Nest drains, Prisma disconnects. Allow a grace period of **at least
15 seconds** before SIGKILL — a client may be mid-stream on a local-storage row.

## 4. Resources

Derived from what the process actually does, not from a benchmark — treat as a
starting point and confirm under real traffic.

| | |
|---|---|
| Memory | **512 MiB minimum, 1 GiB recommended.** Baseline is a Nest app plus one Prisma client. Headroom matters because `GET /videos/:id/stream` streams local files (`createReadStream`, not buffered) and the rate limiter holds an in-memory bucket per client IP. |
| CPU | **1 vCPU.** JSON-only request handling. No transcoding in this process (§8). The one CPU-heavy operation is bcrypt at cost factor 12 — roughly 300 ms per login/password verification — so concurrent logins, not catalog reads, are what saturate a core. |
| Disk | **None persistent, once media is on R2.** See §6. |

## 5. Database

| | |
|---|---|
| Engine | **PostgreSQL** (`prisma/schema.prisma` `provider = "postgresql"`) |
| Version | **16** — what `docker-compose.yml` and CI both use. Nothing requires 16 specifically; do not go below 14. |
| Extensions | **None.** No migration issues `CREATE EXTENSION`. |
| Connection | `DATABASE_URL`. Use the provider's internal/private hostname; append `?sslmode=require` on any connection leaving the provider network. |
| Migration command | **`npx prisma migrate deploy`** |
| Migration safety | All 22 migrations are **additive** — no `DROP TABLE`, no `DROP COLUMN`, no `TRUNCATE`, no `DELETE` outside a comment. Four perform additive backfills. |
| Never run | `prisma migrate reset`, `prisma db push` — both are destructive. |
| Pool | Prisma's default per process. One instance is well inside a small managed tier's limit. |

**Seeding is a deliberate decision, not a step.** `npm run db:seed` is an
idempotent upsert of 40 curated rows whose `storageKey`s are *relative local
paths*. On a production deployment those rows are unplayable until the media
migration runs. Seed only if you intend to then migrate the media.

## 6. Storage and media

| | |
|---|---|
| Driver | `STORAGE_DRIVER=local` (default) or `r2`. **Production wants `r2`.** |
| Provider | Any S3-compatible endpoint; built and tested against **Cloudflare R2** (`forcePathStyle: true`). |
| Bucket | **Private.** Playback is served by short-lived presigned GET URLs (15 min), so `r2.dev` public access and a custom media domain are both unnecessary. |
| Network | Outbound HTTPS from the app to the storage endpoint. |
| Persistent disk | **Not required once media is on R2.** |
| `STORAGE_ROOT` | **Required at boot and must already exist as a directory, even under `STORAGE_DRIVER=r2`** (`env.validation.ts` stats it). On a container, create it or point at an existing empty path. |

⚠️ **`STORAGE_DRIVER=r2` does not migrate anything.** Playback source is
decided **per row** by `resolvePlaybackSource`: a row with an
`objectStorageKey` is served from R2, a row with only a `storageKey` is served
off `STORAGE_ROOT` by the Node process. **40 of 42 published rows are currently
in the second category.** Until they are migrated, a production container
serves them from an empty directory. See `docs/R2_MEDIA_MIGRATION.md`.

## 7. Reverse proxy, HTTPS, scaling

Every managed platform terminates TLS at a proxy in front of this process.

| | |
|---|---|
| TLS | Terminated by the platform. The app speaks plain HTTP behind it. |
| **`TRUST_PROXY_HOPS`** | **Set to `1`** on any managed platform (one router/ingress in front). `0` (the default) means "no proxy". Set the *real* number of hops. |
| Why it matters | Every per-IP control reads `request.ip`: the global throttler (300/min), `LOGIN_RATE_LIMIT` (5/min), `WHATSAPP_OTP_REQUEST_RATE_LIMIT` (3/10min), and the `Session.ipHash` / `AuthAuditEvent.ipHash` audit trail. Left at `0` behind a proxy, every caller reports the proxy's address — the 5-logins-per-minute ceiling becomes 5 logins per minute **for the entire user base**. |
| Never | `trust proxy: true`. Trusting the whole `X-Forwarded-For` chain lets any client forge unlimited rate-limit identities. The variable is a hop **count** for that reason. |
| CORS | `CORS_ORIGINS` — comma-separated exact origins. **Empty is correct for a mobile-only V1**: Android is not a browser and sends no `Origin`. The default is deny-all, never `*`. In production each entry must be a bare `https://host[:port]` — no path, query, fragment or trailing slash. `*` is refused in every environment (it is parsed as a list, so it would match an origin literally named `*`, i.e. nothing). |
| Scaling | **Single instance for V1.** Rate-limit state is in-memory per process, so N instances give each client N× the intended budget. Horizontal scaling requires a shared throttler store first. |
| Sticky sessions | Not needed — auth is stateless bearer tokens, no cookies. |

## 8. What is NOT required for V1

Each is gated off by default; none needs provisioning.

| Component | Gate | Notes |
|---|---|---|
| Redis | `TRANSCODE_ENABLED=false` | Only the BullMQ transcode queue uses it. |
| ffmpeg / ffprobe | — | Used by the importer and the transcode worker, neither of which runs in the API process. |
| Worker process | `TRANSCODE_ENABLED=false` | `dist/worker/main` is a separate entrypoint. Not started for V1. |
| HLS gateway Worker | `TRANSCODE_ENABLED=false` | The Cloudflare Worker in `workers/hls-gateway` is **not deployed**; its `wrangler.toml` is an unmodified template. |
| Payment provider | `PAYMENTS_ENABLED=false` | Every `/payments/*` route answers `503`. |
| WhatsApp OTP vendor | Meta WhatsApp Business (Cloud API) | **REQUIRED for V1.** Set `WHATSAPP_AUTH_ENABLED=true`, `WHATSAPP_OTP_PROVIDER_DRIVER=cloud-api`, plus the four `WHATSAPP_CLOUD_API_*` sender variables. Needs a Meta app, a verified sender number, a System User token and an APPROVED authentication template — see [WHATSAPP_LOGIN_SETUP.md](WHATSAPP_LOGIN_SETUP.md). Boot refuses every incomplete posture. |
| Cron / scheduler | `RETENTION_SCHEDULE_ENABLED=false` | Registers no job when off. |

## 9. Environment variables

`.env.production.example` is the authoritative, documented contract. Summary:

**Required — the process will not boot without these**

`PORT` · `PUBLIC_BASE_URL` · `STORAGE_ROOT` · `CORS_ORIGINS` · `DATABASE_URL` ·
`JWT_ACCESS_SECRET` · `JWT_REFRESH_SECRET` · `AUTH_AUDIT_IP_HASH_SECRET`

`CORS_ORIGINS` must be *declared*; **empty is a valid value** and is the
right answer for a mobile-only V1.
The three secrets must all **differ from each other** — boot refuses
otherwise, naming the two variables and never a value.

Under `NODE_ENV=production` every **client-facing** URL must be an absolute
**https** origin that is neither loopback nor a private/LAN address:
`PUBLIC_BASE_URL` (stamped into every local-storage row's `playbackUrl`),
`OBJECT_STORAGE_ENDPOINT` when `STORAGE_DRIVER=r2` (every presigned GET is
signed against it, so it becomes the `playbackUrl` of every R2 row and every
series `coverUrl`), `HLS_GATEWAY_BASE_URL` when `TRANSCODE_ENABLED=true`,
and `OBJECT_STORAGE_PUBLIC_BASE_URL` when set. `DATABASE_URL` and
`REDIS_URL` are deliberately exempt — they are internal infrastructure and
are never handed to a client.

**Required when the corresponding flag is on**

| Flag on | Additionally required |
|---|---|
| `STORAGE_DRIVER=r2` | `OBJECT_STORAGE_ENDPOINT`, `_REGION`, `_BUCKET`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY` |
| `TRANSCODE_ENABLED=true` | `REDIS_URL`, `HLS_GATEWAY_BASE_URL`, `HLS_TOKEN_SECRET` (must differ from all three auth secrets) |
| `GOOGLE_AUTH_ENABLED=true` | `GOOGLE_OAUTH_CLIENT_IDS` (≥1 non-empty entry) |
| `PAYMENTS_ENABLED=true` | `MIDTRANS_SERVER_KEY` |

**Optional, with documented defaults**

`TRUST_PROXY_HOPS` (0) · `STORAGE_DRIVER` (local) · `OBJECT_STORAGE_PUBLIC_BASE_URL` ·
`HLS_TOKEN_TTL_SECONDS` (3600) · `TRANSCODE_MAX_ATTEMPTS` (3) ·
`TRANSCODE_STALLED_AFTER_MINUTES` (30) · `TRANSCODE_CLEANUP_GRACE_MINUTES` (120) ·
`REWARDS_ENABLED` (false) · `REWARDS_TIMEZONE` (Asia/Jakarta) ·
`ADS_INTERSTITIAL_ENABLED` · `ADS_MIN_VIDEOS_BETWEEN_ADS` · `ADS_MAX_VIDEOS_BETWEEN_ADS` ·
`ADS_MIN_SECONDS_BETWEEN_ADS` · `ADS_GRACE_VIDEOS` · `RETENTION_SCHEDULE_*`

**Must hold exactly these values in production**

`NODE_ENV=production` · `DEV_TOOLS_ENABLED=false` ·
`WHATSAPP_OTP_PROVIDER_DRIVER=` (empty — the literal `fake` refuses the boot)

**Must never be set in production**

`DATABASE_URL_TEST` · `RUN_R2_SMOKE` · `RUN_R2_MEDIA_SMOKE` · `RUN_R2_HLS_SMOKE` ·
`SERIES_COVER_ORPHAN_APPLY_BUCKET`

## 10. Acceptance

Two gates, at two moments. Neither deploys anything.

**Before deploying** — judges a configuration that has not shipped yet.
Read-only: no connection, no query, no bucket, no write, and it prints no
secret value. Reports `PASS`/`WARNING`/`BLOCKER` and exits non-zero on any
blocker.

```
npm run production:preflight
```

It does not read `.env` on purpose (absorbing the developer's local file
would grade the wrong configuration and pass). Supply the real values:
`env $(grep -v '^#' .env.production | xargs) npm run production:preflight`.

**After deploying** — the deployment is ready when this passes against the
real origin:

```
API_BASE_URL=https://<origin> npm run smoke:production
```

It exercises the full anonymous-guest path — health, ads config, feed, a
dynamically-selected free episode, its detail and playback authorization —
and then checks the thing nothing else checks: that the returned playback URL
is https, is not loopback/LAN, carries no filesystem path, and **actually
serves bytes** to a ranged GET. It exits non-zero otherwise.
