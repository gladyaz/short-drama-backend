# short-drama-backend

Phase 5A: a minimal NestJS backend for the mobile short-drama app. It exposes
company video metadata and securely streams local MP4 files with HTTP
Range-request support, so the mobile app can move off the temporary Python
HTTP server.

Phase 8 added a real database (via Prisma) and a JWT-based `/auth/*`
module (register/login/refresh/logout/me) — see "Auth API" and "Database"
below. Phase 8P migrated that database from SQLite to PostgreSQL, which is
now the only Prisma provider used by this project (see "Database" below).

Phase 9 added per-user Like/Save state and per-user watch progress, backed by
two new Prisma tables (`UserVideoInteraction`, `WatchProgress`) — see
"Interactions & Progress API" below.

## Architecture

```
mobile app (Expo/React Native)  -->  NestJS backend  -->  local company storage (STORAGE_ROOT)
                                            |
                                            +-->  PostgreSQL database (DATABASE_URL, via Prisma)
```

- The backend never copies, moves, or renames company video files. It reads
  them in place from `STORAGE_ROOT` and streams bytes on request.
- Each video's `storageKey` is a path relative to `STORAGE_ROOT` (e.g.
  `短剧下载/10-雨夜校花（34集）/01.mp4`), never an absolute filesystem path.
  The backend resolves `storageKey` against `STORAGE_ROOT` at request time and
  rejects any resolved path that would escape the storage root.
- **Final MP4 files already contain embedded Indonesian subtitles.** This
  phase does no subtitle processing, transcription, translation, or dubbing —
  the mobile app plays the final MP4 as-is and must not request separate
  subtitle tracks or render subtitle overlays.
- No uploads. Video metadata now lives in a Prisma-backed `Video` table in
  the PostgreSQL database (seeded from the same 40 records that previously lived
  in `src/videos/videos.data.ts`) rather than an in-memory array — see
  "What changed in Phase 8" below. Company video *files* themselves are still
  never touched by the database; only metadata rows point at `storageKey`
  values.
- As of Phase 8, the backend also has a real user database (`User`,
  `Session` tables) and JWT-based authentication (`/auth/*`). Company video
  catalog/streaming (`GET /videos/feed`, `GET /videos/:id`,
  `GET /videos/:id/stream`) does **not** require authentication. As of Phase
  9, the new per-video Like/Save routes (`POST`/`DELETE /videos/:id/like`,
  `POST`/`DELETE /videos/:id/save`) and the new per-user routes
  (`GET /users/me/interactions`, `PUT /series/:id/progress`,
  `GET /users/me/progress`) **do** require a valid `Authorization: Bearer
  <accessToken>` header — see "Interactions & Progress API" below.

## Environment variables

| Variable             | Purpose                                                                 |
| --------------------- | ------------------------------------------------------------------------ |
| `PORT`                | Port the server listens on (binds `0.0.0.0` so a simulator/device on the same network can reach it) |
| `PUBLIC_BASE_URL`     | Base URL used to build each video's `playbackUrl`                        |
| `STORAGE_ROOT`        | Absolute path to the company video storage folder (read-only)            |
| `CORS_ORIGINS`        | Comma-separated list of allowed origins (e.g. the Expo dev server on `:8081`, the admin dashboard's Vite dev server on `:5173`) — see "Development flow: admin dashboard + mobile app" below |
| `DATABASE_URL`        | Prisma connection string for the PostgreSQL dev database (e.g. `postgresql://USER:PASSWORD@localhost:5433/short_drama_dev`) — added in Phase 8, migrated from SQLite to PostgreSQL in Phase 8P |
| `DATABASE_URL_TEST`   | Prisma connection string for a **dedicated** PostgreSQL test database (e.g. `.../short_drama_test`) — added in Phase 8P so `npm run test:e2e` never runs against dev data; required, or e2e tests fail loudly at startup (see "Database" below) |
| `JWT_ACCESS_SECRET`   | Secret used to sign/verify short-lived (~15 min) access tokens — added in Phase 8 |
| `JWT_REFRESH_SECRET`  | Secret used to key the HMAC-SHA256 hash of refresh tokens before they're persisted — added in Phase 8 |
| `STORAGE_DRIVER`      | Which storage backend is active: `local` (default; unset/empty also resolves to `local`) or `r2` — added in Phase 11, work unit 11G-3. See "Storage driver (`STORAGE_DRIVER`)" below. |
| `ADS_INTERSTITIAL_ENABLED` | Optional. `true`/`false` toggle for the interstitial-ad system exposed by `GET /config/ads` — added in Phase 15A, slice 15A-S1. See "Ads config API" below. |
| `ADS_MIN_VIDEOS_BETWEEN_ADS` | Optional. Lower bound of the randomized ad-threshold range — added in Phase 15A, slice 15A-S1. See "Ads config API" below. |
| `ADS_MAX_VIDEOS_BETWEEN_ADS` | Optional. Upper bound of the randomized ad-threshold range — added in Phase 15A, slice 15A-S1. See "Ads config API" below. |
| `ADS_MIN_SECONDS_BETWEEN_ADS` | Optional. Cooldown (seconds) between shown ads — added in Phase 15A, slice 15A-S1. See "Ads config API" below. |
| `ADS_GRACE_VIDEOS`    | Optional. Lifetime video watches exempt from ads — added in Phase 15A, slice 15A-S1. See "Ads config API" below. |
| `TRANSCODE_ENABLED`   | Optional. `true`/`false` (default `false`) feature flag for the HLS transcode-request queue — added in Slice 11N. See "HLS transcode queue foundation" below. |
| `REDIS_URL`           | Required only when `TRANSCODE_ENABLED=true`; unused/optional otherwise — added in Slice 11N. See "HLS transcode queue foundation" below. |
| `TRANSCODE_MAX_ATTEMPTS` | Optional (default `3`). Retry cap per processing generation — added in Slice 11P. See "Production transcoding lifecycle" below. |
| `TRANSCODE_STALLED_AFTER_MINUTES` | Optional (default `30`). Stalled-`running`-row detection window — added in Slice 11P. See "Production transcoding lifecycle" below. |
| `TRANSCODE_CLEANUP_GRACE_MINUTES` | Optional (default `120`). Orphaned-HLS-staging cleanup grace window — added in Slice 11P. See "Production transcoding lifecycle" below. |

Configuration is validated at startup: the app refuses to start if any
required variable is missing, or if `STORAGE_ROOT` does not exist / is not a
directory, with a clear error message. The five `ADS_*` variables above are
NOT part of that startup validation — every field is optional and falls back
to its own documented default (see "Ads config API" below).

### Storage driver (`STORAGE_DRIVER`)

`STORAGE_DRIVER=local` (the default) preserves this project's existing
behavior byte-for-byte and only requires `STORAGE_ROOT` above —
`OBJECT_STORAGE_*` variables stay fully optional. `STORAGE_DRIVER=r2` is a
feature flag only: it makes the app fail fast at startup (a clear,
secret-free message naming the missing variable, never its value) if any of
the **five required** `OBJECT_STORAGE_*` variables is unset, plus a
shape-only check that `OBJECT_STORAGE_ENDPOINT` is a valid `http(s)` URL.
Neither mode makes a network call at startup, and setting
`STORAGE_DRIVER=r2` does not yet change what `StorageService` actually
does — real request-time R2 wiring is a separate, later, human-gated step.
See `docs/r2-readiness.md` for the full rollback and credential-insertion
runbook.

#### Private vs. public R2: the sixth variable (Phase 11, work unit 11H-B1)

`STORAGE_DRIVER=r2` requires exactly **five** variable names to boot:
`OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_REGION`, `OBJECT_STORAGE_BUCKET`,
`OBJECT_STORAGE_ACCESS_KEY_ID`, `OBJECT_STORAGE_SECRET_ACCESS_KEY`. A
**sixth**, `OBJECT_STORAGE_PUBLIC_BASE_URL`, is **optional** — the app boots
fine without it.

This split exists because the dev R2 bucket is **private**: `r2.dev` public
access is disabled and no custom domain is configured, so upload and
playback both go through **presigned PUT/GET URLs**
(`StorageService.createPresignedPutUrl`/`createPresignedGetUrl`), never a
public URL. None of `createPresignedPutUrl`, `createPresignedGetUrl`,
`headObject`, `objectExists`, `deleteObject`, or `putObject` ever read
`publicBaseUrl` — only `StorageService.buildPublicUrl` does, and that method
has **zero callers in production code** today (only its own spec exercises
it).

`OBJECT_STORAGE_PUBLIC_BASE_URL` only matters once a **public** bucket or a
**custom domain** exists to serve public object URLs from. If
`buildPublicUrl` is ever called without one configured, it throws a clear,
secret-free configuration error naming the missing variable (never a value)
instead of silently assembling an invalid URL — an empty base URL would
otherwise produce something that merely *looks* like a valid relative path
(e.g. `/videos/abc.mp4`), which is a worse failure mode than a loud error.
When a base URL **is** configured, `buildPublicUrl`'s behavior (including
its trailing-slash/leading-slash normalisation) is unchanged from before
this work unit.

An opt-in, real-network disposable-object smoke test
(`src/storage/storage-r2-smoke.spec.ts`, work unit 11G-4) round-trips a
single uniquely-named object (`put` → `head` → `delete`) against an
**already-existing** bucket. It **auto-skips with zero network calls**
unless both `RUN_R2_SMOKE=1` is set explicitly AND every `OBJECT_STORAGE_*`
variable is present — the default state in every environment, including
CI. It never creates a bucket. See `docs/r2-readiness.md` section 3 for the
key-naming and cleanup discipline.

`JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` must be two **different** random
values (see `.env.example` for how to generate real ones locally). Real
secret values are never checked into this repo or written into its
documentation — `.env.example` only ever holds placeholder text.

### Create your `.env`

```bash
cp .env.example .env
```

Then edit `.env` with real local values, for example:

```
PORT=3000
PUBLIC_BASE_URL=http://localhost:3000
STORAGE_ROOT=/absolute/path/to/your/company-video-storage
CORS_ORIGINS=http://localhost:8081,http://localhost:5173
```

For testing from a physical device on the same Wi-Fi network, set
`PUBLIC_BASE_URL` to your Mac's LAN IP instead of `localhost`
(e.g. `http://192.168.1.23:3000`).

`.env` is git-ignored and must never be committed — it contains the real,
machine-specific `STORAGE_ROOT` path. `.env.example` holds only generic
placeholder values and is safe to commit.

### Development flow: admin dashboard + mobile app (Phase 12, work unit 12F-B1)

Two separate frontends normally talk to this backend directly — neither
needs a reverse proxy:

- The **mobile app** (Expo dev server) runs on `http://localhost:8081` and
  calls this backend on `http://localhost:3000`.
- The **admin dashboard** (`short-drama-admin`, Vite dev server) runs on
  `http://localhost:5173` and also calls this backend on
  `http://localhost:3000`.

Both origins are cross-origin from this backend's point of view, so **both
must be present in `CORS_ORIGINS`** or the browser's CORS preflight
(`OPTIONS`) will reject the request before it ever reaches a route handler —
this looks like a generic "Something went wrong"/network error in the
browser, not an obviously CORS-shaped message. `.env.example` ships both
`http://localhost:8081` and `http://localhost:5173` as placeholder-safe
local-development origins; make sure your own `.env` includes both (plus
any LAN-IP variant you use for physical-device testing) rather than
narrowing this list down to just one frontend.

`CORS_ORIGINS` is parsed as an explicit, comma-separated allowlist (see
`src/config/configuration.ts`) — there is no wildcard, no reflected-`Origin`
fallback, and no "allow everything outside production" branch. An origin
not present in the list is always refused, in every environment, including
production; see "CORS allowlist behavior" below for the full detail.

## Running the server

```bash
npm install
npm run start:dev   # watch mode
# or
npm run start        # single run
```

On startup you should see logs confirming the port, public base URL, and CORS
origins — and an immediate, readable error if `STORAGE_ROOT` is misconfigured.

### CORS allowlist behavior (Phase 12, work unit 12F-B1)

`app.enableCors({ origin: appConfig.corsOrigins })` in `src/main.ts` is
given the parsed `string[]` from `CORS_ORIGINS`, never a raw string. The
underlying `cors` middleware treats an array `origin` as an **explicit
allowlist**, not a wildcard: it only sets `Access-Control-Allow-Origin` when
the request's `Origin` header exactly matches one entry, and otherwise sets
no CORS header at all — the browser then blocks the request client-side.
This means:

- **No wildcard.** `CORS_ORIGINS` is never passed to `enableCors` as the
  literal string `origin: '*'`, and the array form is not treated as a
  wildcard even if an operator mistakenly put a literal `*` entry in it
  (the `cors` package only special-cases `*` when `origin` itself is the
  string `'*'`, not an array containing it) — so accidental "unblock
  everything" misconfiguration is not possible for this call shape.
- **No reflected `Origin`.** Only origins present in the parsed list ever
  get echoed back; the request's `Origin` header is never returned verbatim
  for a non-allowlisted origin.
- **No "allow everything outside production" branch.** `corsOrigins` is
  built the same way regardless of `NODE_ENV` — there is no environment
  check anywhere in this path.
- **Unset/empty `CORS_ORIGINS` is not permissive.** `CORS_ORIGINS` is a
  required environment variable (`src/config/env.validation.ts`); the app
  refuses to boot at all if it is missing. If it is set to a value that
  parses down to zero usable origins (e.g. only whitespace or a lone
  comma — `src/config/configuration.ts`'s `split(',').map(trim).filter`
  drops empty entries so a trailing/stray comma never becomes an empty
  allowed origin), the resulting allowlist is simply empty and **every**
  origin is refused, including in production — fails closed, not open.
- **Credentials support is unchanged by this work unit.** `enableCors` here
  does not set `credentials: true`, so `Access-Control-Allow-Credentials` is
  not sent today; this file's auth flow does not rely on browser-managed
  cookies for the admin dashboard or mobile app, so this was left as-is.

## How videos are mapped

Video metadata records (each shaped like a `VideoRecord`) are read from the
Prisma-backed `Video` table in the PostgreSQL database (`DATABASE_URL`), seeded
from the same 40 curated records that originally lived in
`src/videos/videos.data.ts` (that file is kept only as historical seed
source, no longer read at request time — see "Database" below). Each
record's `storageKey` is relative to `STORAGE_ROOT`. At request time,
`VideosService` resolves `storageKey` against `STORAGE_ROOT`, confirms the
result stays inside the storage root (rejecting any path traversal), and
confirms the file exists before streaming it. `playbackUrl` in every API
response is generated dynamically as:

```
${PUBLIC_BASE_URL}/videos/${id}/stream
```

The mobile app never receives an absolute filesystem path — only the relative
`storageKey` (for reference) and the generated `playbackUrl`.

## API

### `GET /health`

```json
{ "status": "ok", "service": "short-drama-backend" }
```

### `GET /videos/feed`

Returns registered video metadata records that are both `published` and
playable: rows in `draft`/`ready`/`unpublished`/`failed` lifecycle state are
excluded, and — closing a residual leak the lifecycle filter alone doesn't
cover (work unit 11G-1) — so is any `published` row with **no playable
source at all**: an empty local `storageKey` (`""`) AND a null
`objectStorageKey`. A row is kept if either source is present. Every one of
the 40 original curated rows has a non-empty `storageKey`, so this is a
no-op for existing content; it only matters for rows created by the admin
media pipeline (see "Admin content management API" below) that are marked
`published` before any real file exists.

### `GET /videos/:id`

Returns one video's metadata, or a structured 404:

```json
{ "statusCode": 404, "code": "VIDEO_NOT_FOUND", "message": "Video not found" }
```

### `VideoResponseDto.accessTier` (work unit "Episode Access-Tier + Category Contract Hardening")

Every `VideoResponseDto` — on `GET /videos/feed`, `GET /videos/:id`, and each
episode embedded in `GET /series/:id` (they share the exact same shape) —
carries an additive `accessTier: "free" | "premium"` field: the resolved,
effective access tier for that specific episode. `"premium"` means streaming
or requesting a playback URL for it requires an active entitlement (see
"Entitlements API" below); `"free"` means it does not. This is computed by
the SAME single resolver (`resolveAccessTier`,
`src/entitlements/entitlement.constants.ts`) that `GET /videos/:id/stream`
and `GET /videos/:id/playback` already enforce and that
`SeriesPublicDto.hasPremiumEpisodes` already aggregates over — the three can
never disagree, by construction. A client no longer needs to know
`FREE_EPISODE_LIMIT` (or any episode-number-based rule) at all: `accessTier`
is the single source of truth for whether a given episode needs an
entitlement.

The raw admin-set `Video.accessTierOverride` column that may have produced
this value is a SEPARATE, admin-only field — it is never included on
`VideoResponseDto`, only on the admin-only `AdminMediaDto` (see "Admin
content management API" below, which also exposes the same resolved
`accessTier` next to it for convenience).

### `GET /videos/:id/stream`

Streams the underlying MP4 with Range support. Responds `206 Partial Content`
with `Content-Range` when a `Range` header is supplied, or a full `200` with
the whole file otherwise. Never loads the full file into memory — it streams
from disk with `fs.createReadStream`.

**Requires `Authorization: Bearer <accessToken>` (Phase 10, work unit
10-B3).** Previously this route had no guard at all — any client with a
video id could stream the file directly. Episodes 1-5 (`FREE_EPISODE_LIMIT`)
stream for any authenticated user; episode 6+ additionally requires an
active premium entitlement (see "Entitlements API" below), checked before
the file is even opened. A denied request returns `403
ENTITLEMENT_REQUIRED`. This is the outcome for every video today, but as
of work unit 11F-4 it is actually decided by the row's explicit
`Video.accessTierOverride` DB value (which every row carries, backfilled
to match this exact rule for existing content), not derived solely from
`episodeNumber` at request time — see "`PATCH
/admin/media/:id/access-tier`" under the admin content-management API
below for the full explanation.

Error codes used across the video API: `VIDEO_NOT_FOUND`, `MEDIA_FILE_NOT_FOUND`,
`INVALID_MEDIA_RANGE`, `INVALID_STORAGE_PATH`, `INVALID_ACCESS_TOKEN`,
`ENTITLEMENT_REQUIRED`. Responses never include stack traces or absolute
filesystem paths.

`GET /videos/feed` and `GET /videos/:id` (metadata only) remain
unauthenticated — only the stream route (the protected asset itself)
requires a token.

### Public catalog: `GET /series` and `GET /series/:id`

Work unit "SERIES METADATA + DISCOVER ARTWORK CONTRACT": public,
**unauthenticated** endpoints for curated series metadata — a `Series`
row exists purely as an application-level annotation of an existing
`Video.seriesId` grouping (no DB-level foreign key; see `src/series/series
.service.ts`'s class doc for why), and until this work unit there was no
public read API for it at all (only the admin-guarded `/admin/series`
CRUD from Phase 11, documented in `docs/admin-api-contract.md`). Neither
route changes `GET /videos/feed`'s shape, status codes, or ordering in any
way — both are purely additive.

#### `GET /series`

Returns every active (not archived), non-empty curated series:

```json
{ "items": [ /* SeriesPublicDto[] */ ] }
```

Wrapped in an `{ "items": [...] }` envelope rather than a bare array — the
admin `GET /admin/media` list already establishes a paginated
`{ items, total, page, pageSize }` envelope precedent in this codebase; this
shape means real pagination fields could be added to the SAME object later
without a breaking change (clients already read `.items`). `total`/`page`/
`pageSize` are deliberately omitted for now: with exactly 4 curated series
and no pagination actually implemented, adding those fields would be
presenting fabricated metadata as real — the same "no fabrication" rule
this contract applies to dates and view counts. `GET /videos/feed` is
UNCHANGED by this — it stays a bare `VideoResponseDto[]`, its own
established, unrelated contract.

`SeriesPublicDto`:

```json
{
  "id": "series-104",
  "title": "Malapetaka Datang: Benteng Bergerakku",
  "coverUrl": null,
  "category": "action",
  "sourceLanguage": "zh",
  "episodeCount": 10,
  "totalLikes": 650,
  "hasPremiumEpisodes": true
}
```

- `coverUrl`: a presigned R2 GET URL (same `StorageService
  .createPresignedGetUrl` mechanism `GET /videos/:id/playback` already uses
  for R2-backed video, minted fresh per request, never persisted) built
  from `Series.coverImageKey`, or `null` if no cover has been uploaded.
  **Every one of the 4 real series is `null` today** — a full poster/
  key-art audit (DB columns, R2 key references, upload records, seed/
  fixtures, docs, local assets, migrations) found no cover or thumbnail art
  anywhere in this system (`Video.coverImageKey`/`thumbnailImageKey` are
  0/42 populated). This is reported honestly as `null`, never fabricated.
  Named `coverUrl` (not `posterUrl`) to mirror the `xImageKey` -> `xUrl`
  transform this codebase already uses for `Video.thumbnailImageKey` ->
  `VideoResponseDto.thumbnailUrl`.
- `category`/`sourceLanguage`: the shared value across the series's
  published, `contentKind: "drama"` episodes, or `null` if there are none
  or if they disagree — never guessed.
- `episodeCount`/`totalLikes`/`hasPremiumEpisodes`: truthful aggregates
  computed at request time from those same episodes (never persisted on
  `Series`, so they can never go stale). `hasPremiumEpisodes` reuses the
  exact same `EntitlementsService.resolveEpisodePremium` rule the stream/
  playback routes already enforce. Rankings/aggregates here are strictly
  likes-based — no views, trending, or date-based signal is ever
  fabricated.

A `Series` row whose `seriesId` grouping currently has **zero** qualifying
episodes (published AND `contentKind: "drama"`) is silently excluded — this
is also the mechanism that keeps a QA-fixture-only grouping (e.g. the 11R
HLS sample's `series-11rqa`) from ever appearing here: no `Series` row is
ever created for one (the backfill migration only creates the 4 real,
verified series), and even if one existed, it would have zero qualifying
episodes.

#### `GET /series/:id`

Returns one series's canonical metadata plus **every** qualifying episode,
in the exact same `VideoResponseDto` shape `GET /videos/feed` already
returns (built from the same shared mapping function, so the two can never
drift), ordered by `episodeNumber` ascending — the natural intra-series
viewing order, distinct from `GET /videos/feed`'s own cross-series curated
`sortOrder`:

```json
{
  "id": "series-104",
  "title": "Malapetaka Datang: Benteng Bergerakku",
  "coverUrl": null,
  "category": "action",
  "sourceLanguage": "zh",
  "episodeCount": 10,
  "totalLikes": 650,
  "hasPremiumEpisodes": true,
  "episodes": [ /* VideoResponseDto[] */ ]
}
```

`404 { "statusCode": 404, "code": "SERIES_NOT_FOUND", "message": "Series not found" }`
for three distinct conditions, deliberately collapsed into one outcome
(matching this codebase's existing anti-enumeration precedent, e.g.
`VIDEO_NOT_FOUND` for both "no such video" and "not published"): no such
`Series` row; a `Series` row that exists but is archived (archived is
excluded from the public surface entirely here, unlike the admin
`GET /admin/series/:id`, which intentionally still returns an archived
row for operational reasons); or a `Series` row with zero qualifying
episodes.

#### Canonical titles and admin write access

The 4 real series' titles were verified against `src/videos/videos.data.ts`
— the actual seed source `prisma/seed.ts` imports to populate every one of
the 40 real `Video` rows these `seriesId`s describe — and cross-checked
against the live, seeded `Video.title` values (e.g. `series-010` episode
1's persisted title is literally `"Kue Gulung Kaya Raya: Kedaiku Menembus
Waktu - Episode 1"`). No runtime string heuristic (split/replace/regex on
an episode title) is used anywhere; see the backfill migration's own doc
comment (`prisma/migrations/20260814142551_backfill_series_metadata`) for
the full source citation. An admin can edit a series's `title`/`sortOrder`
any time via the existing `PATCH /admin/series/:id` (Phase 11, work unit
11E-4).

#### `Video.category` — canonical set (work unit "Episode Access-Tier + Category Contract Hardening")

`category` (on `VideoResponseDto`, and on `SeriesPublicDto`/`SeriesDetailPublicDto`
as the shared-or-null aggregate described above) is one of exactly four
values: **`action`, `comedy`, `drama`, `romance`** (`VIDEO_CATEGORIES`,
`src/videos/video-category.constants.ts`) — lowercase, matching every real
category this backend has ever documented or seeded. This set was derived
from an audit of this backend's own actual data (`src/videos/videos.data.ts`,
the verified seed source for all 40 real episodes — one category per series
— and a read-only inspection of `short_drama_dev`), not copied from the
mobile app's own broader, differently-cased `VideoCategory` type (which
includes values like `Revenge`/`Family`/`CEO`/`Historical` this backend has
never sent).

Every write path that can put a value in `Video.category` now validates
against this closed set and rejects an unrecognised value with a clean
`400`: `POST /admin/media` and `PATCH /admin/media/:id` (both documented
under "Admin content management API" below), and the bulk importer
(`MediaImporterService`, work unit 11D-1). This is enforced entirely in
application code (`class-validator @IsIn(VIDEO_CATEGORIES)` on the two admin
DTOs; a plain `isValidVideoCategory` guard in the importer) — `Video.category`
itself is unchanged, still a plain `String` column, matching this schema's
existing `lifecycleState`/`contentKind`/`Entitlement.tier` precedent of
"closed set enforced in code, not a DB enum/migration."

**This is a forward-looking, write-time-only guarantee.** No existing row was
rewritten: a read-only audit of `short_drama_dev` found the 40 real episodes
already using exactly these four lowercase values, plus exactly one
non-canonical outlier — `"Drama"` (capital D) — on the known QA fixture
`media-11rqa-8ac6a7f3` (a `contentKind: "qa_fixture"` row, never part of the
real catalog or any public `Series`). That one row is left untouched and is
still served exactly as persisted; nothing added by this work unit reads or
narrows `Video.category` on the way out.

**Known consequence for that one fixture row (independent-review finding,
2026-08-15):** the Admin Dashboard's episode-metadata form submits ALL
fields as a full replacement, pre-filled from the read response — so ANY
metadata edit to `media-11rqa-8ac6a7f3` via that form (even a title typo
fix) will now be rejected with 400 (`category must be one of ...`) until
the operator retypes the category field to a canonical lowercase value
(e.g. `drama`). This is the closed-set validation working as designed, not
a defect; it is recorded here so it does not surprise anyone while that QA
fixture is still alive for 11R device QA.

**Cover art upload (work unit "SERIES COVER UPLOAD BACKEND CONTRACT",
2026-08-14 — a real, verified path for admins to upload the poster art
noted above as unpopulated for all 4 series).**
`coverImageKey` is no longer written by simply PATCHing an arbitrary string —
the recommended path is a verified two-step upload:
`POST /admin/series/:id/cover` (presign-init: `{contentType, sizeBytes}`,
closed image allow-list, 10 MiB max, server-generated key) then
`POST /admin/series/:id/cover/complete` (`{key}`: HEAD-verifies the object
actually exists with an allowed content type and size, ONLY THEN persists
`Series.coverImageKey`). `PATCH /admin/series/:id { coverImageKey: null }`
remains the only way to explicitly CLEAR a cover; a raw string via `PATCH`
still works for a manually-known key but bypasses verification, so the
upload flow is preferred. See `docs/admin-api-contract.md`'s "Admin series"
section (2026-08-14 re-freeze) for the full request/response shapes, error
codes, and replace/orphan semantics.

**Fix cycle 1 (2026-08-15) — stale/replayed `complete` closed.** A reviewer
proved that, because nothing was persisted at presign time, a
stale/replayed `POST .../cover/complete` carrying an OLD, already-superseded
key could silently revert a legitimate replace or un-clear an explicit
`PATCH { coverImageKey: null }`. Closed with an additive
`Series.pendingCoverImageKey` column (mirrors the 11P
`TranscodeIntentService` durable-intent precedent): the presign step records
the freshly minted key there (latest mint wins), and `complete` now only
accepts a `key` that matches the current pending key (normal path) or the
current live `coverImageKey` (idempotent no-op) — any other well-formed key
is rejected with `409 SERIES_COVER_KEY_SUPERSEDED`. An explicit
`PATCH { coverImageKey: null }` also clears the pending key. See
`docs/admin-api-contract.md`'s 2026-08-15 re-freeze note for full detail,
including the documented (not yet automated) orphan-cleanup and
Content-Type/Length verification caveats for a never-completed upload.

**Hardening (2026-08-18) — concurrent (not just replayed) completions
closed.** The fix-cycle-1 currency check compares `key` against a row read
BEFORE the storage `HEAD` round-trip, while the final write was
unconditional — so a completion could pass the check, be superseded DURING
verification (a `PATCH { coverImageKey: null }` removal, or a newer presign),
and still win the write, resurrecting a removed cover or reverting a newer
one. `complete`'s final write is now an atomic compare-and-set conditioned on
`pendingCoverImageKey` still equalling the completing key at the instant of
the write (same conditional-write shape `AuthService.refresh`/
`revokeSession` already use for `Session.revokedAt`). A completion that loses
it writes NOTHING — it cannot resurrect a removed cover, cannot revert a
newer cover, and cannot clear the newer pending intent that beat it — and is
answered with the same `409 SERIES_COVER_KEY_SUPERSEDED`. Two SIMULTANEOUS
completions of the SAME key both verify, exactly one writes, and both get the
`200` no-op answer a sequential duplicate has always received. No schema
migration was needed. A superseded-but-uploaded object stays in R2 as an
orphan (deliberately — no automatic cover-object cleanup exists). Known
limitation, unchanged and now explicitly documented: only the `null`
(Remove) form of `PATCH /admin/series/:id` revokes an outstanding upload
intent — writing a `coverImageKey` string directly by hand does not, so a
completion of a still-valid pending intent will legitimately replace that
hand-written value afterwards. See `docs/admin-api-contract.md`'s
2026-08-18 hardening note.

### What changed in Phase 8 (internal only)

`/videos/feed`, `/videos/:id`, and `/videos/:id/stream` are now backed by a
real database (a Prisma `Video` model, PostgreSQL as of Phase 8P) instead of the in-memory
`videos.data.ts` array. This is purely an internal storage-layer change —
request/response shapes, status codes, and error codes for all three routes
are unchanged from Phase 5A. `VideosService` still resolves `storageKey`
against `STORAGE_ROOT`, still rejects path traversal, and still streams
bytes directly from disk; only where the metadata row comes from changed.

## Auth API (Phase 8)

Backed by the same Prisma/PostgreSQL database as `/videos/*` (see "Database"
below). Passwords are hashed with bcrypt (cost factor 12); refresh tokens are
opaque random strings, only an HMAC-SHA256 hash of which is ever persisted.

### `POST /auth/register`

No auth required. Body:

```json
{ "email": "user@example.com", "password": "at-least-8-chars", "displayName": "optional" }
```

- `email`: must be a valid email address.
- `password`: string, 8–128 characters (no complexity rules beyond length).
- `displayName`: optional string, 1–100 characters.

Returns `201` with `AuthResponseDto`:

```json
{
  "user": { "id": "...", "email": "...", "displayName": "..." },
  "accessToken": "<jwt, ~15 min lifetime>",
  "refreshToken": "<opaque random string, ~30 day lifetime>"
}
```

Errors: `409 EMAIL_ALREADY_REGISTERED` if the email (case-insensitive) is
already registered.

### `POST /auth/login`

No auth required. Body: `{ "email": "...", "password": "..." }`. Returns
`200` with the same `AuthResponseDto` shape as register.

Errors: `401 INVALID_CREDENTIALS` for either an unrecognized email or a wrong
password — deliberately the same generic code/message for both, so a caller
cannot enumerate registered emails. A dummy bcrypt comparison is always run
even when the email doesn't match any user, to keep response timing
consistent between the two failure cases.

### `POST /auth/refresh`

No auth (Bearer) header required — the refresh token itself is the
credential. Body: `{ "refreshToken": "..." }`. Returns `200` with a new
`AuthResponseDto` (rotated access + refresh token).

Refresh tokens are single-use: each successful refresh revokes the presented
token and issues a new one. Errors: `401 INVALID_REFRESH_TOKEN` for an
unknown, expired, or already-used/revoked refresh token. Reuse of an
already-rotated token is treated as a possible theft signal and revokes all
of that user's other active sessions as a defensive measure.

### `POST /auth/logout`

No auth (Bearer) header required. Body: `{ "refreshToken": "..." }`. Returns
`200 { "success": true }`. Idempotent and silent for an unknown or
already-revoked token (does not reveal whether the token ever existed).

### `GET /auth/me`

Requires `Authorization: Bearer <accessToken>`. Returns `200` with the
current user's `AuthUserDto` (`id`, `email`, `displayName`).

Errors: `401 INVALID_ACCESS_TOKEN` for a missing/malformed `Authorization`
header, an expired access token, an invalid-signature/tampered token, or
(checked at this route specifically, since the guard itself doesn't hit the
database) a token whose user id no longer exists in the database.

This is intentionally the smallest possible authenticated route — a working,
tested example of `JwtAuthGuard` + `@CurrentUser()` for future routes to
copy, not a general-purpose profile endpoint.

### `POST /auth/change-password` (Phase 12, work unit 12B-B1)

Requires `Authorization: Bearer <accessToken>`. Body:

```json
{
  "currentPassword": "the caller's existing password",
  "newPassword": "at-least-8-chars",
  "refreshToken": "the CURRENT session's own refresh token"
}
```

- `currentPassword`: re-verified server-side against the stored bcrypt hash
  before anything changes.
- `newPassword`: same 8–128 character policy as `POST /auth/register` (the
  single source of truth — no second, divergent policy).
- `refreshToken`: identifies which of the caller's sessions is "the current
  one". The access-token payload carries only the user id (`sub`) — no
  session-id claim — so, exactly like `/auth/refresh` and `/auth/logout`,
  the current session is identified by the plaintext refresh token supplied
  in the body.

On success, returns `200` with a new `AuthResponseDto` (a rotated
access/refresh token pair for the current session, so the calling device
stays authenticated with fresh credentials) and:

- Revokes **every other session** for the account (all sessions except the
  one just rotated) — including a session created by a concurrent `login()`
  call using the still-valid CURRENT password at the exact moment the
  password change runs. This is enforced by two unconditioned (no time-window
  bound) revoke sweeps inside the same database transaction as the password
  update — one before, one immediately after creating the replacement
  session — rather than a wall-clock cutoff, which cannot reliably
  distinguish "created moments too late" from "created by an unrelated
  caller." Verified empirically against real concurrent traffic (repeated,
  no-artificial-delay races, both `changePassword` vs. `changePassword` and
  `changePassword` vs. `login`) with zero surviving extra sessions observed.
  The guarantee is narrowed to the database commit round-trip, though: a
  `login()` call whose session creation lands inside the window between the
  final sweep and the `changePassword` transaction's COMMIT can still retain
  an extra active session. This has not been observed organically across
  290+ concurrent-race iterations (210 by independent review across 4
  interleavings, 80 during implementation) — zero survivors — and is only
  reproducible via direct instrumentation of the commit boundary (20/20 when
  forced), not via ordinary concurrent HTTP traffic. Fully closing it would
  require serializing `login()`'s password check against a lock
  `changePassword()` holds — deliberately not attempted in this work unit,
  tracked as a follow-up.
- **Invalidates every outstanding password-reset token for the account**
  (password-reset invalidation slice). A successful password change opens a
  new credential generation, and a recovery artifact minted under the old one
  may not replace the new credential: every still-usable `PasswordResetToken`
  row is marked `usedAt` in the SAME transaction as the password update, so a
  reset link issued before the change (e.g. one an attacker captured) stops
  working the moment the account owner changes the password. Previously such
  a token stayed usable for its full 1-hour TTL and could overwrite the
  brand-new password. Three properties of this are deliberate and tested:
  a FAILED change (wrong `currentPassword`, unusable `refreshToken`, or a
  lost session-rotation race) invalidates **nothing** — so a stolen access
  token cannot be used to destroy the owner's recovery path; an
  ALREADY-EXPIRED token is left untouched (it is unusable either way, and
  stamping it would rewrite the audit trail's `expired` reason into
  `already_used`); and requesting a **new** reset afterwards works normally —
  recovery is never disabled, only the previous generation's artifacts are.
  No new audit event is emitted: the invalidation is a documented side effect
  of `change_password_success` (a per-token trail would leak how many reset
  requests the account had outstanding).
- Never returns a session record, a `refreshTokenHash`, or any other
  hash/secret in the response body.
- The old (pre-change) refresh token is now revoked — reusing it via
  `/auth/refresh` afterward is caught by that route's existing replay/reuse
  detection (revokes every session for the account defensively), exactly as
  it would for any other rotated token.

Errors: `401 INVALID_CREDENTIALS` (same generic body login failures use) for
a wrong `currentPassword`; `401 INVALID_REFRESH_TOKEN` for an unknown,
expired, already-revoked, or cross-account `refreshToken` (a refresh token
belonging to a different account is never usable here — this is
IDOR-safe/ownership-scoped, not merely unlikely to happen); `400` for a
`newPassword` that fails the length policy. There is no dedicated rate limit
or account-lockout coupling for this route (unlike `login`) — it is
authenticated already and falls under the app-wide default throttler like
every other authenticated route.

### `POST /auth/logout-all` (Phase 12, work unit 12B-B2)

Requires `Authorization: Bearer <accessToken>`. No request body.

**Frozen contract: this logs the caller out EVERYWHERE, including the
device/session that made this very call.** There is no "current session"
carve-out here — every `Session` row for the account is revoked
unconditionally. This is a deliberate, explicit design decision (recorded in
DECISIONS.md's Phase 12 approval): the "revoke every OTHER session but keep
me signed in" need is already served by `POST /auth/change-password`
(work unit 12B-B1); this endpoint is the separate, more aggressive "log out
everywhere" option, not a duplicate of it.

Returns `200 { "success": true }`. Every outstanding refresh token for the
account stops working immediately afterward (any subsequent
`POST /auth/refresh` gets `401 INVALID_REFRESH_TOKEN`). The access token
this call itself was authenticated with remains cryptographically valid
until it naturally expires (~15 min) — this app's access tokens are
stateless JWTs (see `JwtAuthGuard`'s existing "does not re-check user
existence per request" gap below); this is the same pre-existing property
`POST /auth/logout` already has for the one session it revokes, not a new
gap introduced by this endpoint.

Errors: `401 INVALID_ACCESS_TOKEN` for a missing/malformed/expired/invalid
access token (same as every other guarded route).

### `GET /auth/sessions` (Phase 12, work unit 12B-B2)

Requires `Authorization: Bearer <accessToken>`. Returns `200` with an array
of the caller's **own** currently-active sessions only — never another
account's, and never a `refreshTokenHash`/`ipHash`/any other hash or secret:

```json
[
  {
    "id": "...",
    "userAgent": "Mozilla/5.0 ... or null",
    "lastUsedAt": "2026-07-28T00:00:00.000Z or null",
    "createdAt": "2026-07-28T00:00:00.000Z",
    "expiresAt": "2026-08-27T00:00:00.000Z"
  }
]
```

Revoked sessions are excluded (this is a "manage your logged-in devices"
view, not a history log — see `AuthAuditEvent`/the audit trail for that).
`userAgent`/`lastUsedAt` are `null` for a session created without request
context (e.g. directly through `AuthService` in a test) or predating this
work unit. Errors: `401 INVALID_ACCESS_TOKEN`.

### `DELETE /auth/sessions/:id` (Phase 12, work unit 12B-B2)

Requires `Authorization: Bearer <accessToken>`. Ownership-scoped revoke (not
a row delete — the underlying `Session.revokedAt` is set, matching every
other session-lifecycle action in this codebase). Returns `204 No Content`
on success.

A session id that does not exist at all, and a session id that exists but
belongs to a **different** account, are both refused with the exact same
`404 SESSION_NOT_FOUND` — a cross-account revoke is impossible, not merely
unlikely, and this endpoint cannot be used to probe which session ids exist
for other accounts. Revoking an already-revoked session of your own is a
safe, idempotent no-op (also `204`), mirroring `POST /auth/logout`'s
existing idempotent-on-already-revoked precedent.

Errors: `401 INVALID_ACCESS_TOKEN`; `404 SESSION_NOT_FOUND`.

### Session metadata: `userAgent` / `ipHash` / `lastUsedAt` (Phase 12, work unit 12B-B2)

`Session` gained three additive, nullable columns (DECISIONS.md "Phase 12
... approved..." entry, decision 6), populated everywhere a session is
created or refreshed (`register`, `login`, `refresh`'s replacement session,
`change-password`'s replacement session):

- `userAgent`: the raw `User-Agent` request header, truncated to 255
  characters and stripped of control characters before storage — never
  persisted verbatim/unbounded.
- `ipHash`: an HMAC-SHA256 digest of the client IP, keyed with
  `AUTH_AUDIT_IP_HASH_SECRET` (the same dedicated secret `AuthAuditEvent`
  already uses — see that env var's `.env.example` comment). **The raw IP
  address is never stored anywhere on the `Session` row, or in any
  session-listing response.**
- `lastUsedAt`: set when a session is created, and updated on the old
  session row at the exact moment `POST /auth/refresh` rotates it out. This
  app's access tokens are stateless JWTs and refresh tokens rotate (rather
  than being mutated in place) on every use, so "created" and "rotated out
  by a refresh" are the only two events that ever touch this column today.

The IP-hashing and user-agent-sanitization logic lives in one shared place
(`src/auth/auth-crypto.ts`), used by both `AuthAuditService` (for
`AuthAuditEvent`) and `AuthService` (for `Session`) — never two divergent
implementations of the same hash/sanitize step.

### `POST /auth/password-reset/request` (Phase 12, work unit 12B-B3)

Unauthenticated. Body:

```json
{ "email": "someone@example.test" }
```

**Frozen contract: always returns `202`, with the identical body shape,
regardless of whether `email` resolves to a real account** (DECISIONS.md
"Phase 12 ... approved..." entry, decision 3) — this is an anti-enumeration
guarantee, mirroring `POST /auth/login`'s existing "same generic error either
way" precedent, applied here at the "does this email exist" layer:

```json
{ "success": true }
```

- If the email resolves to a real account, a single-use, expiring
  (`PasswordResetToken`) row is created for it. **No row is ever created for
  a nonexistent email** — mirroring `AccountLockout`'s existing "a
  nonexistent email never causes a row to be created" precedent — so this
  table cannot be used to enumerate which emails are registered, even with
  raw database access.
- **The raw reset token is returned in the response body (as `devToken`)
  ONLY when `DEV_TOOLS_ENABLED=true` AND `NODE_ENV` is exactly `development`
  or `test`.** `env.validation.ts` already refuses to boot the app at all
  unless `NODE_ENV` is one of those two exact values while the flag is on —
  a deliberate allowlist, not merely "not production" (Phase 12, work unit
  12D-B2, commit `7cfd411` — see the "Entitlements API" section's
  `/dev/entitlements/grant` writeup below for the full history, including
  the original Phase 10, work unit 10-B5 exact-string denylist check this
  replaced), so this can only ever be observed on a developer's own
  machine, never in production. This conditional deliberately lives in the
  RESPONSE SHAPING, not a `DevToolsGuard` route guard: a guard would reject
  the ENTIRE route (404) whenever the flag is off, which would break this
  endpoint's own "always returns 202" contract for every environment except
  a developer's own machine with the flag on. The route always executes
  normally; only the `devToken` field is conditionally attached.
- **The token is committed on exactly one side of the credential boundary**
  (password-reset invalidation slice). The INSERT runs inside a transaction
  that first takes the account's `User` row lock (`FOR SHARE` — the same mode
  `POST /auth/login` uses, since this route never writes the `User` row), so
  it is ordered against `change-password` / `password-reset/confirm` /
  account deletion: a token is either committed strictly BEFORE a password
  change (and is therefore invalidated by it) or strictly AFTER it (and is
  therefore legitimately usable). Previously this was a bare auto-commit
  INSERT with no ordering at all, so a token could commit while a
  `change-password` transaction was still mid-flight — issued while the old
  password was current, yet surviving the change. The lock is deliberately
  the weak `FOR SHARE`: it conflicts with the three credential mutators but
  not with itself or with `login`, so concurrent logins and concurrent reset
  requests for the same account are never newly serialized. A side effect is
  that a request racing an account deletion now resolves through this route's
  normal "no account" path instead of failing on a foreign key. Residual, and
  shared with `POST /auth/login`'s existing `FOR SHARE` guard rather than new
  to this route: the wait counts against Prisma's default 5s interactive-
  transaction budget, so pathological lock contention on one account could in
  principle surface as a `500` instead of the contracted `202`. All three
  credential mutators do their bcrypt work OUTSIDE their transactions, so the
  lock is only ever held across a handful of local database round trips —
  reaching that budget is not attacker-reachable (it needs concurrent
  credential mutations on the same account, which need the password).
- **No real email or SMS is ever sent this phase** — that is an explicit,
  hard-scoped-out integration for a future phase. In production (or any
  environment with `DEV_TOOLS_ENABLED` off), the caller has no way to
  retrieve the raw token through this API at all.
- Rate-limited to **3 requests per 10 minutes per IP** (the SAME threshold as
  `POST /auth/register` — both are unauthenticated, low-frequency-legitimate
  -use, state-changing routes).

### `POST /auth/password-reset/confirm` (Phase 12, work unit 12B-B3)

Unauthenticated (no `Authorization` header — the presented token itself is
the only credential in play). Body:

```json
{
  "token": "the raw reset token (from the dev-only devToken field, in dev)",
  "newPassword": "at-least-8-chars"
}
```

- `newPassword`: the SAME 8–128 character policy as `POST /auth/register` /
  `POST /auth/change-password` — the single source of truth.

On success, returns `200 { "success": true }` and:

- Sets the new password.
- Marks the token **single-use** — a second confirm with the same token
  fails.
- **Revokes EVERY session for the account** — deliberately MORE aggressive
  than `POST /auth/change-password` (which keeps the calling device's own
  session alive with a rotated token pair): a password reset exists
  specifically for the scenario where the account may already be
  compromised, so there is no session worth sparing, and **no replacement
  session is issued either** — the caller must log in again afterward with
  the new password, the same end state `POST /auth/logout-all` leaves the
  account in.

Errors: `401 INVALID_PASSWORD_RESET_TOKEN` — used identically whether the
token does not exist, was already used, has expired, or was invalidated by a
successful `POST /auth/change-password` (never distinguished, mirroring the
`INVALID_CREDENTIALS`/`INVALID_REFRESH_TOKEN` anti-enumeration precedent — a
token killed by a password change must not be tellable apart from one that
never existed, in the response body or in its timing); `400` for a `newPassword` that fails the length policy.
Rate-limited to **5 requests per minute per IP** (the SAME threshold as
`POST /auth/login`).

### `PasswordResetToken` (Phase 12, work unit 12B-B3)

Additive table. `tokenHash` (never the raw token) is an HMAC-SHA256 digest of
the raw token, keyed with `JWT_REFRESH_SECRET` — the SAME secret
`Session.refreshTokenHash` already uses, reused deliberately (not a silent
default): a reset token and a refresh token are cryptographically the same
kind of value (an opaque, high-entropy bearer secret checked only via a
keyed-hash match, never bcrypt), so they share the same hashing key rather
than this phase minting a fourth long-lived auth secret. `usedAt` (nullable,
set exactly once) enforces single-use; `expiresAt` bounds the token to a
1-hour window independently of use. `usedAt` is written by THREE paths, all
meaning "this token is spent": the confirm that consumed it, that same
confirm's invalidation of the account's other outstanding tokens, and (added
by the password-reset invalidation slice) a successful
`POST /auth/change-password`. No `revokedAt`/`generation`/`status` column was
added — the existing single-use field already expresses invalidation exactly,
so this required **no schema migration**, and the retention sweep below
already treats `usedAt`-stamped rows as collectable. `onDelete: Cascade` — an outstanding
reset token for a deleted account is discarded along with it.

### Known gaps in the Auth API

- ~~No rate limiting on `/auth/login` or `/auth/register`~~ — **resolved**
  in Phase 12, work unit 12A-B1 (commit `5570c79`): `@nestjs/throttler`
  enforces `POST /auth/login` at 5/min/IP, `POST /auth/register` at
  3/10min/IP, and `POST /auth/refresh` at 30/min/IP
  (`src/common/rate-limit.constants.ts`), plus a **persistent**
  PostgreSQL-backed `AccountLockout` model (15-minute lockout after 10
  failed logins within 15 minutes for the same account) that survives a
  server restart, unlike the IP throttling. The IP-level throttling itself
  remains in-memory per app instance (a shared/persistent IP-rate store
  across multiple backend instances is deliberately deferred to Phase 13,
  DECISIONS.md decision 4) — that in-memory scope is the one part of this
  item still open, not the absence of any limiting at all.
- **`JwtAuthGuard` does not re-check user existence per request.** It only
  verifies the access token's signature and expiry; it does not query the
  database on every guarded request (unlike refresh-token handling, which is
  fully DB-backed). In practice this means a deleted/deactivated user's
  already-issued access token keeps working until it naturally expires
  (~15 minutes), even though `GET /auth/me` itself does catch this case by
  looking the user up explicitly. This tradeoff was noted during the 8-B6
  review and accepted for this phase to keep per-request auth cheap.
- **Historical `Session.revokedAt` values written by `changePassword` before
  Phase 12, work unit 12D-B0, may be skewed by this server's Postgres
  session `TimeZone` (`Asia/Jakarta`, UTC+7 — confirmed via `SHOW
  TimeZone`).** `AuthService.changePassword`'s revoke-all-sessions
  statement is raw SQL (`tx.$queryRaw`, required for its `RETURNING "id"`
  race-resolution clause — see that method's doc comment), and until this
  work unit assigned a JS `Date` parameter (which Prisma binds as
  `timestamptz`) directly to the naive `timestamp(3)` `"revokedAt"` column
  with no `AT TIME ZONE 'UTC'` conversion. Postgres silently reinterpreted
  the instant using the session's local offset, storing a value measured at
  ~7 hours (25,200,000ms) LATER than the true revoke instant. This is now
  fixed (the statement writes `${now} AT TIME ZONE 'UTC'`, mirroring the
  existing correct idiom in `confirmPasswordReset` and
  `AccountLockoutService.recordFailure`), verified by a real-database
  regression test (`src/auth/change-password-session-timezone.spec.ts`) and
  confirmed non-vacuous by a mutation test (removing the conversion
  reproduces the ~7-hour-skewed failure). **Rows written before this fix are
  deliberately left uncorrected**: `Session` has no `revokedBy`/
  `revokedReason` column, and every OTHER revocation path
  (`logout`/`logoutAll`/`revokeSession`/`refresh`'s reuse-detection
  sweep/`confirmPasswordReset`, and even `changePassword`'s OWN second
  defensive sweep a few lines below the raw SQL) writes `revokedAt` via
  Prisma's typed ORM, which was independently verified (empirically, via a
  real `.create()` call logged and compared against the JS wall clock) to
  already store the correct UTC instant regardless of session timezone — so
  a historically-corrupted row is not reliably distinguishable, after the
  fact, from a correct one (a same-account `AuthAuditEvent` timestamp
  correlation is not precise enough, since the skew's exact magnitude was
  never itself recorded, multiple `change_password_success` events can exist
  per account, and the two sweeps within one `changePassword` transaction
  share the same audit event with no per-row attribution). A blanket
  "shift every value by 7 hours" backfill would therefore corrupt the
  (unknown, but likely larger) set of already-correct rows it cannot avoid
  touching, so no data migration was made — a destructive/irreversible
  correction is a hard prohibition for this phase regardless. **For Phase
  12D-B1 (retention/cleanup):** the skew, where it exists, is one-directional
  (an affected row's `revokedAt` reads ~7 hours LATER than reality, never
  earlier), so a coarse, multi-day retention window (e.g. "purge sessions
  revoked more than N days ago") is not at risk of deleting data
  prematurely from this specific defect — at worst an affected row is kept
  for a few hours longer than strictly necessary before the next run
  catches it. Retention logic should not, however, assume `revokedAt` is
  precise to the hour for any row that predates this fix.

## Account Deletion API (Phase 12, work unit 12C-B1)

### `POST /users/me/deletion`

Requires `Authorization: Bearer <accessToken>`. Body:

```json
{
  "currentPassword": "the caller's existing password",
  "confirmDeletion": true
}
```

- `confirmDeletion` must be the **literal boolean `true`** — a missing
  field, `false`, or the **string** `"true"` are each rejected with a clean
  `400` by the global `ValidationPipe` (`@IsBoolean()` then `@Equals(true)`
  on `AccountDeletionDto`) before the request ever reaches `AuthService`.
  This is decision 1's "explicit irreversible confirmation payload", not
  merely a client-side prompt.
- `currentPassword`: re-verified server-side via `bcrypt.compare` against
  the stored hash, same as `POST /auth/change-password`.
- There is no id in the path, query, or body — the account acted on is
  always the caller's own, resolved exclusively from the verified access
  token (`JwtAuthGuard` / `@CurrentUser()`), so there is no client-supplied
  identifier for a cross-account attempt to even target.

**This is the most destructive endpoint in this codebase. Deletion is
immediate, hard, and irreversible: there is no grace period, no "undo",
and no cancellation endpoint.** Once `200 { "success": true }` is
returned, the `User` row and everything decision 1/2 say should cascade
with it are already gone.

On success, returns `200 { "success": true }` and, in one
`prisma.$transaction`:

- Revokes every session for the account (`Session.revokedAt` set for all
  outstanding rows).
- Hard-deletes the `User` row.

**What is cascade-deleted vs. what survives, scrubbed/anonymized**
(DECISIONS.md decision 2, and decision 1 of the 2026-07-30 "Phase 12
decision-resolution remediation slice (12E)" entry) — every `User`-relation
model in `prisma/schema.prisma` falls into exactly one of two buckets, both
enforced by real Postgres foreign-key constraints, not application code:

- **Cascade-deleted (`onDelete: Cascade`), removed outright:** `Session`,
  `UserVideoInteraction`, `WatchProgress`, `Entitlement`,
  `PasswordResetToken`, `AccountLockout`. A deleted-then-re-registered email
  therefore cannot inherit a stale lockout or a leftover interaction/progress
  row — it is gone, not merely orphaned.
- **Survives, `userId` set to `null` (`onDelete: SetNull`):**
  `AnalyticsEvent.userId` and `AuthAuditEvent.userId`. For `AnalyticsEvent`
  that is the whole story — the model has no `ipHash`/`userAgent`/other
  IP-derived column, so nulling `userId` alone genuinely anonymizes the row,
  as decision 2 requires. **`AuthAuditEvent` is different, and `SetNull`
  alone is NOT sufficient**: `ipHash` is an unsalted, unrotated HMAC of the
  client IP — a globally stable value — so a row that kept it after `userId`
  went `null` would still be correlatable to any other live session/account
  sharing that IP, with no brute-forcing required. Calling that
  "anonymized" would be wrong (this is what `TASK_QUEUE.md` follow-up 7
  flagged, and `DECISIONS.md`'s 2026-07-30 decision 1 is explicit that a
  globally stable HMAC must never be described as anonymous). **Work unit
  12E-B1 closes that gap:** inside this same deletion transaction, **before**
  `tx.user.deleteMany` runs, the caller's own `AuthAuditEvent` rows are
  explicitly scrubbed — `userId`, `ipHash`, `userAgent`, and `metadata` (via
  `Prisma.DbNull`, a true SQL `NULL`, not `Prisma.JsonNull`) are all set to
  `null`, preserving only `event` and `createdAt`. **Ordering is
  load-bearing, not stylistic:** `onDelete: SetNull` fires synchronously the
  instant `tx.user.deleteMany` runs, so a scrub placed AFTER that call would
  query `where: { userId }` against rows whose `userId` is already `null`
  and silently scrub nothing — see `AuthService.deleteAccount`'s doc comment
  (`src/auth/auth.service.ts`) and `account-deletion.service.spec.ts`'s
  dedicated ordering test for the full reasoning and the regression test
  that pins it. After this scrub, a deleted user's `AuthAuditEvent` rows
  genuinely carry no `userId`/`ipHash`/`userAgent`/`metadata` — only
  `event`/`createdAt` remain, which is real, not cosmetic, anonymization.

`account_deletion_success` is emitted to `AuthAuditEvent` **after** the
transaction commits, and **deliberately without a `userId`** — two separate
reasons, not one: (1) emitting inside the transaction could record a
"success" for a deletion that then fails to commit, since `AuthAuditService.emit`
is intentionally best-effort and swallows its own errors; (2) inserting a
**new** row with a non-null `userId` for a user that no longer exists would
be rejected by the foreign key outright — `SetNull` only fires when an
*existing* referenced row is deleted, never on an insert of a dangling
reference. Omitting `userId` still leaves a genuinely useful record (an
accurate, timestamped count of real account deletions) without violating
decision 2. The two `account_deletion_failed` audit events below (wrong
password / forbidden role) are the opposite case — the account still
exists, so `userId` **is** included, matching `change_password_failed`'s
existing precedent.

**Order of checks (deliberate, not incidental) — see the doc comment on
`AuthService.deleteAccount` for the full reasoning:**

1. Does the access token's `userId` still resolve to a real `User`? If not,
   `401 INVALID_ACCESS_TOKEN` — the same code `GET /auth/me` already uses
   for "authenticated but the user no longer exists". This is also this
   endpoint's **idempotency story**: a second `POST /users/me/deletion`
   call with the same (still cryptographically valid, since access tokens
   are stateless) access token after the account was already deleted lands
   here, not a 500.
2. Is `currentPassword` correct? Checked **before** the role check below.
   No other endpoint this app exposes to its own owner surfaces `User.role`
   (`GET /auth/me` returns only `id`/`email`/`displayName`), so checking
   role first would let a caller holding a stolen-but-still-valid access
   token learn "this account is privileged" for free, without ever knowing
   the password. Checking the password first means that information is only
   reachable by someone who already knows it — at which point they already
   have full control of the account through every other authenticated
   route, so nothing new leaks. A wrong password fails with the same generic
   `401 INVALID_CREDENTIALS` `POST /auth/login` uses.
3. Is `user.role === 'user'`? Any other role (e.g. `admin`) is refused with
   a distinct `403 ACCOUNT_DELETION_FORBIDDEN` — safe to be specific here
   precisely because it is only reachable after the correct password was
   already verified (point 2 above). Self-service deletion of a privileged
   account is a separate, not-yet-built process this phase deliberately
   does not create.

Errors:

- `400` — `confirmDeletion` missing, `false`, or a non-boolean value
  (including the string `"true"`). The account is untouched.
- `401 INVALID_CREDENTIALS` — wrong `currentPassword`. The account is
  untouched.
- `401 INVALID_ACCESS_TOKEN` — missing/malformed/expired/invalid access
  token, **or** the account behind a still-valid access token has already
  been deleted (the idempotency case above — a repeated call after
  deletion always lands here, never a 500).
- `403 ACCOUNT_DELETION_FORBIDDEN` — the authenticated account's role is
  not `"user"` (e.g. `admin`/operator). Admin and operator accounts are
  refused by design; deleting one requires a separate, not-yet-built
  process.
- `429` — rate-limited to **5 requests per 15 minutes**, a dedicated,
  tighter-than-default `@Throttle()` override (unlike `change-password`/
  `logout-all`/`sessions`, which rely on the app-wide default) precisely
  because this action is irreversible — see `ACCOUNT_DELETION_RATE_LIMIT`'s
  doc comment in `src/common/rate-limit.constants.ts`.

## Data Export API (Phase 12, work unit 12C-B2)

### `GET /users/me/export`

Authenticated (`JwtAuthGuard`). No id in the path or query — the export is
always for the caller's own account, resolved exclusively from the verified
access token. Synchronous JSON response (per `DECISIONS.md` decision 5 —
**no** `DataExport` storage model, background job, or expiring cloud link
this phase):

```json
{
  "exportedAt": "2026-07-29T00:00:00.000Z",
  "profile": {
    "email": "user@example.com",
    "displayName": "Display Name or null",
    "memberSince": "2026-01-01T00:00:00.000Z"
  },
  "interactions": [
    {
      "videoId": "video-104-01",
      "videoTitle": "Episode title, or null if the video no longer exists",
      "isLiked": true,
      "isSaved": false,
      "updatedAt": "2026-07-29T00:00:00.000Z"
    }
  ],
  "watchProgress": [
    {
      "seriesId": "series-104",
      "videoId": "video-104-01",
      "videoTitle": "Episode title, or null",
      "episodeNumber": 1,
      "positionSeconds": 42,
      "durationSeconds": 300,
      "updatedAt": "2026-07-29T00:00:00.000Z"
    }
  ],
  "entitlements": [
    {
      "tier": "premium",
      "source": "dev-grant",
      "grantedAt": "2026-07-29T00:00:00.000Z",
      "expiresAt": null,
      "revokedAt": null
    }
  ],
  "analyticsEvents": [
    {
      "eventName": "video_play",
      "timestamp": "2026-07-29T00:00:00.000Z",
      "platform": "ios",
      "properties": { "videoId": "video-104-01" }
    }
  ]
}
```

**What is deliberately excluded** (DECISIONS.md decision 5): every internal
database id (including the account's own `User.id`), `role`, `passwordHash`,
every `Session` field (a refresh-token hash, `ipHash`, `userAgent`,
timestamps — `GET /auth/sessions` is the correct surface for that, a
different concern), the entire `AuthAuditEvent`/`AccountLockout`/
`PasswordResetToken` tables (security/audit metadata), and every `Video`
storage field (`storageKey`/`objectStorageKey`/`coverImageKey`/
`thumbnailImageKey`) — resolving a video's `title` for a `videoId` uses an
explicit Prisma `select: { id, title }`, so no storage path is ever even
fetched.

**`analyticsEvents` (Phase 12, work unit 12E-B2 — `DECISIONS.md` decision 2,
2026-07-30):** the caller's own `AnalyticsEvent` history, INCLUDED. This
reverses 12C-B2's original launch-time exclude call (which had been flagged
for human confirmation as `TASK_QUEUE.md` follow-up 10 rather than decided
unilaterally). Per row: `eventName` (already restricted at ingestion to
`EVENT_PROPERTY_ALLOWLIST`'s keys) and `properties`, re-filtered against the
**current** `EVENT_PROPERTY_ALLOWLIST` **at read time**
(`filterEventPropertiesForExport`, `src/analytics/analytics.types.ts`) as
defence in depth — the write-time scrub alone only reflects the allowlist as
it existed when a given row was inserted, so a row written under a past or
future allowlist version could otherwise leak a since-removed key.
`id`/`userId` are excluded (surrogate/redundant, same reasoning as every
other section here). Two deliberate, documented judgment calls: `platform`
(`"ios"`/`"android"`/`"web"`) is INCLUDED — it is a coarse, three-valued
category shared across every user on that platform, not a device/IP
identifier, so it does not fall under decision 2's "IP/device identifiers"
exclusion; and `timestamp` is `AnalyticsEvent.receivedAt` (server-stamped),
**not** the caller-suppliable `clientTimestamp` — see the "Judgment call 1/2
of 2" sections in `src/export/export.types.ts`'s doc comment for the full
reasoning on both. No cap or pagination is added for this section even
though it is the one part of this export whose size can grow materially
faster than the other three (a long-lived, actively-used account's analytics
history has no automatic pruning today — retention for this table is
dry-run/unscheduled, see "Retention & cleanup jobs" below) — decision 2 does
not authorize truncating a user's data.

`videoId`/`seriesId` themselves ARE included: they are catalog identifiers
the client already holds from `/videos/feed`, not internal surrogate ids, and
without them the interactions/watch-progress entries would be meaningless
("you liked 1 thing" with no way to tell which one).

Entitlement history (not just the single current-status boolean `GET
/users/me/entitlement` returns) is included, newest-first, since a personal
export's point is completeness of "what happened to my account."

A fresh account with no interactions/progress/entitlements exports cleanly —
every collection is simply `[]`, never an error.

Emits an `AuthAuditEvent` (`data_export_success`, with the caller's `userId`)
after a successful export — a data export is treated as a security-relevant
action worth being able to investigate later, even though the action itself
is read-only.

Errors: `401 INVALID_ACCESS_TOKEN` — no `Authorization` header, or a token
whose account has since been deleted (the same generic error `GET /auth/me`
already uses for the identical condition, since `JwtAuthGuard` verifies the
token without a database hit). Rate-limited to **10 requests per 5 minutes**
— tighter than the app-wide default (a single call reads several tables and
returns the caller's entire personal dataset at once, a materially cheaper
target for a stolen-token harvesting loop than scraping each `/users/me/*`
endpoint individually) but far more generous than account deletion's 5/15min
(export is read-only and fully reversible, so a legitimate retry/re-export
should not be punished).

## Retention & cleanup jobs (Phase 12, work units 12D-B1, 12E-B3)

`src/retention/RetentionService` implements the retention/cleanup jobs
`phases/phase-12.md`'s "12D" scope calls for — expired/revoked sessions,
expired/used password-reset tokens, `AuthAuditEvent`/`AnalyticsEvent` TTL,
deleted-account residue, and stale watch progress. **These jobs are built
and tested but do NOT run against production data this phase** —
dry-run/opt-in only, per `DECISIONS.md`.

**The four windows below other than `WatchProgress` are human-decided
values** (`DECISIONS.md` "Phase 12 decision-resolution remediation slice
(12E) approved..." entry, decision 3, 2026-07-30, work unit 12E-B3),
superseding 12D-B1's original engineering defaults. `WatchProgress` is the
one target decision 3 does not mention — it is **deliberately left
unchanged at 730 days**, a conservative engineering default (not a product
decision), since it is the only target here that is genuinely user-visible
data rather than backend bookkeeping (see its row below). `PasswordResetToken`
is a **new** retention target added by 12E-B3 — it was not covered by
12D-B1's original five targets at all.

**Nothing here runs automatically by default.** There is no HTTP route, and
the only two ways to invoke `RetentionService` are (1) the explicit CLI
script below, run by hand, and (2) the **opt-in, default-OFF** in-app
scheduler added in Phase 13, work unit 13A-B2 — see "Scheduled retention"
below for that second path in full. (Through Phase 12, `RetentionService`
was not imported by `AppModule` at all; 13A-B2 changed that by adding the
scheduler, but left this section's CLI instructions and both safety gates
below completely unchanged.)

```bash
# Dry run (the default) — reports what WOULD be deleted, deletes nothing,
# against any database:
npm run retention

# Destructive — requires BOTH independent gates below to pass (NODE_ENV
# allowlist AND DATABASE_URL pointed at the isolated test database):
NODE_ENV=development DATABASE_URL="$DATABASE_URL_TEST" npm run retention -- --commit
```

Per `AGENT_RULES.md`, this job must never be run against `short_drama_dev`
or any real company data — the CLI's own guard makes a misconfigured
production run structurally difficult, but that does not itself authorize
running it anywhere; see `TASK_QUEUE.md`'s 12D-B1 row for the full
acceptance record.

**Two independent gates must both pass before a `--commit` run deletes
anything** (`src/retention/retention-env-guard.ts`), checked before a
single Prisma call is issued:

1. **`NODE_ENV` allowlist.** `NODE_ENV` must be exactly `development` or
   `test`. This is a deliberate **allowlist**, not `env.validation.ts`'s
   own (also now allowlist-shaped, since Phase 12 work unit 12D-B2, commit
   `7cfd411`) check — the two are independent gates for two different
   surfaces (dev-tools boot vs. this destructive job) and neither is
   implemented in terms of the other. An unset, empty, misspelled, or
   differently-cased `NODE_ENV` is refused, never silently treated as safe.
2. **`DATABASE_URL`-identity gate**, added in this work unit's own fix
   cycle after review found gate 1 alone insufficient: a normal local shell
   legitimately has `NODE_ENV=development` while `DATABASE_URL` still
   resolves to `short_drama_dev` (the real seeded/QA database) — without
   this second gate, `NODE_ENV=development npm run retention -- --commit`
   would delete against real local data. This gate requires `DATABASE_URL`
   to match `DATABASE_URL_TEST` by a **credential-free** identity
   (`protocol://host:port/dbname`, structurally never reading the
   `user:password@` segment of either string), and pipes every refusal
   message through `redactSensitiveText` as defense in depth. Both gates
   are independent — passing one never satisfies the other — and a refusal
   from either means **zero** database activity for that run — literally
   true as of Phase 13, work unit 13A-B1 (closes `TASK_QUEUE.md` follow-up
   item 22): `scripts/run-retention.ts`'s CLI entry point (via
   `src/retention/run-retention-cli.ts`) now runs this gate BEFORE
   `PrismaService` is even constructed or `$connect()` is called for a
   `--commit` run, not merely before the first query, so "zero database
   activity" includes the connection handshake itself, not only the absence
   of a query on top of an already-open connection.

### Targets and windows

| Target | Column(s) | Window | Why |
|---|---|---|---|
| `Session` | `revokedAt` (if set) OR `expiresAt` | 90 days | A session that is revoked or naturally expired can never authenticate again (`AuthService.refresh` rejects both), and `GET /auth/sessions` only ever lists `revokedAt: null` rows — there is no "session history" surface anywhere in this app. **90 days is human-decided** (decision 3, superseding 12D-B1's original 30-day engineering default); it leaves room for a realistic "I noticed something odd a few weeks ago" investigation via `ipHash`/`userAgent`/`lastUsedAt` before the row is pruned. |
| `PasswordResetToken` | `usedAt` (if set) OR `expiresAt` | 90 days | A new target, added by 12E-B3 — not covered by 12D-B1 at all. Mirrors `Session`'s "explicit end OR natural expiry" shape: `usedAt` non-null is the "revoked" half (the token was consumed and can never be reused), `expiresAt` in the past is the "expired" half. **90 days is human-decided** (decision 3), chosen equal to `SESSION_RETENTION_DAYS` — both are used-or-expired credential/token bookkeeping with no remaining live purpose. |
| `AuthAuditEvent` | `createdAt` | 730 days | The operational SECURITY audit trail. Deliberately the **longest** window here — lower volume, higher evidentiary value per row, and a real investigation can surface weeks after the fact. **730 days is human-decided** (decision 3, superseding 12D-B1's original 180-day engineering default). Applies uniformly regardless of `userId` null-ness — a scrubbed/anonymized row and an identified row age out on the exact same schedule (see "Deleted-account residue" below). |
| `AnalyticsEvent` | `receivedAt` | 180 days | Product telemetry — deliberately kept on a **separate** window from `AuthAuditEvent` (these two models are never merged into one TTL). **180 days is human-decided** (decision 3, superseding 12D-B1's original 90-day engineering default). |
| `WatchProgress` | `updatedAt` | 730 days (2 years, **unchanged by 12E-B3**) | The one target that is genuinely user-**visible** data ("resume where I left off"), not backend exhaust — deleting it early is a real, noticeable product regression, not freed disk space. Growth is bounded by `active users x catalog size` (a `@@unique([userId, seriesId])` constraint), not by request volume, so there is no storage-pressure argument for an aggressive window. Decision 3's table does not mention this target, so it stays a deliberately conservative **engineering** default, not a product decision about what "abandoned" means — a human product owner may reasonably want a different number. |
| Deleted-account residue | n/a (no time window) | n/a | See below. |

Every cutoff is computed at UTC-**day** granularity (`dayGranularityCutoff` in
`retention.util.ts`), never at hour/minute precision — see the bound inherited
from work unit 12D-B0 below.

### The `Session.revokedAt` timezone bound (inherited from 12D-B0)

12D-B0 (commit `642a3af`) fixed `AuthService.changePassword`'s raw-SQL write
to `Session.revokedAt`, which previously stored a value up to **+7 hours**
later than the true revocation instant on this server's `Asia/Jakarta`
(UTC+7, no DST) Postgres session `TimeZone`. Historical rows predating that
fix were deliberately **not backfilled** (affected and correct rows are not
reliably distinguishable after the fact, so a blanket correction would
corrupt the correct ones).

Because the skew is structurally one-directional (a stored value can only
read **later** than reality, never earlier), a **day-granularity** retention
window is safe: the worst case is an affected row is purged up to ~7 hours
**late**, never early. `RetentionService` therefore never compares
`revokedAt` at hour precision, and this bound is written directly into
`retention.constants.ts`'s doc comments so a future maintainer does not
"tighten" the window and silently reintroduce the risk.

### Deleted-account residue

A genuine **orphan** row is one with a non-null `userId` that does not
resolve to any existing `User` row. This is deliberately **not** "any row
with `userId IS NULL`" — `AnalyticsEvent`/`AuthAuditEvent` rows with a null
`userId` are the intended, anonymized record of a deleted account, not
residue, and this job's queries exclude them by construction (rows are only
ever considered candidates when `userId` is a required column in the first
place, or, for the two nullable-`userId` models, only when
`userId: { not: null }`). The two models reach that anonymized state by
different mechanisms: `AnalyticsEvent` via `onDelete: SetNull` alone
(`DECISIONS.md` decision 2 — the model has no `ipHash`/`userAgent` column,
so nulling `userId` is sufficient); `AuthAuditEvent` via `SetNull` **plus**
the explicit pre-delete scrub described in "Account Deletion API" above
(`DECISIONS.md` 2026-07-30 decision 1, work unit 12E-B1) — `SetNull` alone
would leave its stable `ipHash` behind, which must never be described as
anonymizing the row on its own.

Every one of the 8 `User`-relation models in `prisma/schema.prisma` carries
a **real Postgres foreign-key constraint** (`onDelete: Cascade` for
`Session`/`UserVideoInteraction`/`WatchProgress`/`Entitlement`/
`PasswordResetToken`/`AccountLockout`, `onDelete: SetNull` for
`AnalyticsEvent`/`AuthAuditEvent`) — a row referencing a nonexistent
`userId` cannot be **inserted** at all, regardless of whether the write goes
through Prisma's typed client or raw SQL. So under this schema's current
constraints, a genuine orphan is expected to be **impossible**, and this
job's correct, normal outcome is zero matches for all 8 models, always (see
`retention.integration.spec.ts`'s direct proof that Postgres rejects an
attempt to create one). It is still implemented as a real scan, not a
hardcoded zero, so it keeps working as a defensive drift-detector if a
future migration ever weakens one of these constraints.

### Scheduled retention (Phase 13, work unit 13A-B2)

`RetentionModule` (`src/retention/retention.module.ts`) wires an in-app
cron scheduler — `RetentionSchedulerService`, built on `@nestjs/schedule` —
into `AppModule`. This closes the "scheduling is Phase 13's" earmark left by
Phase 12 (`TASK_QUEUE.md` follow-up item 15). It is a **second**, independent
way to invoke `RetentionService`, alongside the `npm run retention` CLI
above, which is completely unchanged by this addition.

**Default OFF, and dry-run by default even when on** — controlled by three
env vars (see `.env.example`):

| Var | Default | Meaning |
|---|---|---|
| `RETENTION_SCHEDULE_ENABLED` | unset → disabled | Must be **exactly** the string `true` to register the cron job at all. Fail-closed: `''`, `'1'`, `'TRUE'`, `'yes'`, or anything else other than the exact lowercase string `true` all mean disabled. When disabled, **zero** retention cron jobs are registered in `@nestjs/schedule`'s `SchedulerRegistry` — not a job that exists but no-ops. |
| `RETENTION_SCHEDULE_CRON` | `0 3 * * *` (daily, 03:00 local) | Standard cron expression, only relevant once `ENABLED=true`. An **invalid** expression fails the app's boot loudly (`RetentionSchedulerService.onModuleInit` lets the underlying `cron` package's own constructor throw, uncaught) — it is never silently ignored or defaulted. |
| `RETENTION_SCHEDULE_COMMIT` | unset → dry run | Must be **exactly** the string `true` for a scheduled tick to request a destructive run (`RetentionService.run({ commit: true })`). Any other value — including unset, the default — is a dry run (`commit: false`): a report only, nothing deleted. |

**Commit mode stays double-gated by the existing env guard — this work unit
does not add a new gate, weaken the old one, or pre-check-and-swallow it.**
Setting `RETENTION_SCHEDULE_COMMIT=true` only changes what the *scheduler*
asks `RetentionService.run` for; `run()` still calls
`assertDestructiveRetentionAllowed()` as its own first action exactly as it
already did (see "Retention & cleanup jobs" above) — outside
`NODE_ENV=development`/`test` **and** `DATABASE_URL` matching
`DATABASE_URL_TEST` by identity, that call still throws. The scheduler does
not intercept or pre-empt that throw; it only **catches** whatever
`RetentionService.run` ultimately resolves or rejects with, so a refused
scheduled commit-mode tick is logged as a structured error and the app stays
healthy — it never crashes the process or produces an unhandled rejection.

**Every scheduled tick logs a report through this repo's existing
structured logging/redaction layer** (`redactSensitiveText`,
`src/common/logging/redact.ts`) — counts only (target name,
matched/deleted counts), never row contents, whether the tick was a dry run
or a commit, and whether it succeeded or failed.

In short: leaving all three vars unset (the shipped `.env.example` default)
reproduces Phase 12's behavior exactly — nothing scheduled, nothing deleted,
`npm run retention` remains the only way anything runs. Turning scheduling
on is opt-in at every layer: registering the job at all, requesting
destructive behavior from it, and the underlying database-identity/
`NODE_ENV` guard that request must still pass.

## Interactions & Progress API (Phase 9)

Backed by two new Prisma tables added in work unit 9-B1:
`UserVideoInteraction` (per-`(userId, videoId)` `isLiked`/`isSaved` state) and
`WatchProgress` (per-`(userId, seriesId)` watch position). Both tables enforce
their unique key at the database level, so each user always has at most one
row per video/series, and different users' rows for the same shared
video/series are always independent (verified explicitly in this work unit's
test suite — see "Testing" below).

All seven routes below require `Authorization: Bearer <accessToken>` (the
same `JwtAuthGuard` used by `GET /auth/me`). A missing/malformed header or an
expired/invalid token returns `401 INVALID_ACCESS_TOKEN`, matching the Auth
API's existing convention. Every route that takes a `videoId` (path or body)
explicitly checks that the video exists first — there is no database-level
foreign key from these tables to `Video` — and returns the same structured
`404 VIDEO_NOT_FOUND` used by `GET /videos/:id` if it doesn't:

```json
{ "statusCode": 404, "code": "VIDEO_NOT_FOUND", "message": "Video not found" }
```

**`Video.likeCount` is now a real, mutable counter**, not a static seeded
display value: `POST /videos/:id/like` increments it and `DELETE
/videos/:id/like` decrements it (floored at 0, never negative), scoped so
concurrent/duplicate calls from the same user never double-count. Liking is
idempotent — liking an already-liked video (by that same user) does not
increment the counter again; unliking a video that isn't currently liked by
that user leaves it untouched.

### `POST /videos/:id/like` / `DELETE /videos/:id/like`

Returns `201` (`POST`) / `200` (`DELETE`) with `LikeResponseDto`:

```json
{ "videoId": "video-104-01", "isLiked": true, "likeCount": 43 }
```

### `POST /videos/:id/save` / `DELETE /videos/:id/save`

Returns `201` (`POST`) / `200` (`DELETE`) with `SaveResponseDto`:

```json
{ "videoId": "video-104-01", "isSaved": true }
```

### `GET /users/me/interactions`

Returns `200` with every `UserVideoInteraction` row belonging to the
authenticated user only, as `UserInteractionDto[]`:

```json
[{ "videoId": "video-104-01", "isLiked": true, "isSaved": false }]
```

### `PUT /series/:id/progress`

Body (`UpsertProgressDto`):

```json
{
  "videoId": "video-104-01",
  "episodeNumber": 1,
  "positionSeconds": 42,
  "durationSeconds": 300
}
```

- `videoId`: string, required — must reference an existing `Video`.
- `episodeNumber`, `positionSeconds`: integers, required, `>= 0`.
- `durationSeconds`: integer, optional, `>= 0`.

A genuine upsert keyed on `(userId, seriesId)`: the first call for a given
user+series creates the row, every subsequent call overwrites it in place
(there is never more than one progress row per user per series). Returns
`200` with `ProgressResponseDto`:

```json
{
  "seriesId": "series-104",
  "videoId": "video-104-01",
  "episodeNumber": 1,
  "positionSeconds": 42,
  "durationSeconds": 300
}
```

Note: the `:id` path param (series id) is not itself validated against a
`Series` table — there is no `Series` entity in this schema (see "Database"
below) — only the body's `videoId` is checked against `Video`.

### `GET /users/me/progress`

Returns `200` with every `WatchProgress` row belonging to the authenticated
user only, as `ProgressResponseDto[]`.

## Entitlements API (Phase 10)

Account-wide premium entitlement, backing the `GET /videos/:id/stream` guard
above. Single tier ("premium"), no per-series/per-episode entitlement — see
`DECISIONS.md` in the control workspace ("Phase 10 approved..." entry) for
why. All routes require `Authorization: Bearer <accessToken>`.

### `GET /users/me/entitlement`

Returns `200` with the current user's entitlement status:

```json
{ "isPremium": false, "expiresAt": null }
```

`isPremium` is `false` for "never entitled," "expired," and "revoked" alike
— this is a deliberately simple contract, not a bug (see DECISIONS.md,
default decision 4).

### `POST /dev/entitlements/grant` / `POST /dev/entitlements/revoke`

**Development/testing only — stand in for a real payment webhook, which is
explicitly out of scope for this phase.** Disabled (`404
DEV_TOOLS_DISABLED`) unless `DEV_TOOLS_ENABLED=true` in your local `.env`.
The app refuses to boot at all if `DEV_TOOLS_ENABLED=true` unless `NODE_ENV`
is exactly `development` or `test` (see `src/config/env.validation.ts`) —
these routes, and the separate `/dev/admin/*` self-service admin-role-grant
routes (not otherwise documented in this README — see
`src/admin/admin.controller.ts`), must never be reachable in a real
deployment. **This is a deliberate allowlist, not merely "not
production"** (Phase 12, work unit 12D-B2, commit `7cfd411`): the original
check compared `NODE_ENV` against the exact
string `'production'`, so an unset, empty, misspelled, or differently-cased
`NODE_ENV` (e.g. `"Production"`) silently passed it and booted with dev
tooling — including this self-service admin-grant surface — live. That was
found to be a HIGH-severity privilege-escalation path in the Phase 12
backend security review (a caller could grant themselves admin) and fixed by
replacing the denylist with an allowlist: only an explicit `development` or
`test` boots with dev tools enabled, everything else refuses to start.

Body (both optional):

```json
{ "targetUserId": "optional, defaults to the caller", "expiresAt": "optional ISO-8601, grant only" }
```

`grant` creates a new active entitlement row (does not merge with an
existing one); `revoke` soft-revokes (sets `revokedAt`) every currently
active entitlement for the target user, mirroring `Session`'s existing
revocation pattern — never a hard delete.

## Analytics & Monitoring (Phase 11)

Self-hosted, zero external egress — events live in the `AnalyticsEvent`
table, logs go to stdout as JSON. No vendor SaaS is wired; see the control
workspace's `DECISIONS.md` ("Phase 11 approved...") for the recorded
tool-choice decisions, including the explicitly deferred native-crash
vendor SDK.

### `POST /analytics/events`

Requires `Authorization: Bearer <accessToken>`. Body: `{ "events": [...] }`,
max 50 events per batch. Each event:

```json
{
  "eventName": "video_play",
  "properties": { "videoId": "video-104-01", "seriesId": "series-104", "episodeNumber": 1 },
  "clientTimestamp": "2026-07-24T10:00:00.000Z",
  "platform": "ios"
}
```

Returns `201 { "accepted": <n> }`. Unknown event names are rejected (400);
unknown property keys and non-scalar values are stripped server-side;
string values are truncated to 2000 chars. The event schema (the single
source of truth is `src/analytics/analytics.types.ts`):

| Event | Allowed properties |
|---|---|
| `feed_view` | — |
| `video_play` | `videoId`, `seriesId`, `episodeNumber` |
| `video_like` | `videoId`, `value` |
| `video_save` | `videoId`, `value` |
| `episode_navigate` | `videoId`, `seriesId`, `episodeNumber`, `source` |
| `premium_gate_hit` | `videoId`, `seriesId`, `episodeNumber`, `source` |
| `app_error` | `message`, `stack`, `isFatal`, `source` |

`AnalyticsEvent.userId` is nullable with `ON DELETE SET NULL`: deleting an
account unlinks identity from its events without destroying aggregate data.

### Structured logging

All log output is JSON (one object per line, via Nest's `ConsoleLogger`
json mode). Every request gets a completion line (`method`, `path` without
query string, `statusCode`, `durationMs`, `userId` when authenticated).
Unhandled exceptions are logged with request context. Everything passes
through `src/common/logging/redact.ts`, which strips `STORAGE_ROOT` paths,
bearer tokens, and password/token JSON fields — never log around it.

### `GET /health/details`

Dev-only (`404 DEV_TOOLS_DISABLED` unless `DEV_TOOLS_ENABLED=true`, same
gate as the entitlement dev routes). Returns uptime, DB reachability,
node/app version — an operator signal beyond the public liveness ping at
`GET /health`.

As of Phase 11, work unit 11G-4, it also includes a `storage` section — a
secret-free storage-readiness signal (Phase 11, work unit 11I-B1 corrected
its `r2` definition and added `publicDeliveryAvailable`):

```json
{ "storage": { "driver": "local", "ready": true, "configPresent": true } }
```

```json
{
  "storage": {
    "driver": "r2",
    "ready": true,
    "configPresent": true,
    "publicDeliveryAvailable": false
  }
}
```

- `driver` — the active `STORAGE_DRIVER` (`"local"` or `"r2"`).
- `configPresent` — whether the required config variable **names** for the
  active driver are all set (`local` → `STORAGE_ROOT`; `r2` → every name in
  `env.validation.ts`'s `REQUIRED_R2_KEYS`) — presence only, never a value.
  This is the **same canonical list boot validation uses**, imported rather
  than restated: `StorageReadinessService` has no requirement list of its
  own, so the two cannot drift. (They did, between work units 11H-B1 and
  11I-B1: this endpoint kept a hard-coded sixth requirement,
  `OBJECT_STORAGE_PUBLIC_BASE_URL`, after boot validation dropped it, which
  made a correctly configured **private** R2 deployment report
  `ready: false` permanently. Fixed in 11I-B1.)
- `ready` — `local`: `STORAGE_ROOT` exists and is a readable directory (a
  local `fs.stat`, never a network call). `r2`: always equal to
  `configPresent` — this endpoint deliberately never makes a live network/R2
  probe, so `ready: true` in `r2` mode means "the required config names are
  set," not "R2 was successfully contacted."
- `publicDeliveryAvailable` (**`r2` mode only**) — whether
  `OBJECT_STORAGE_PUBLIC_BASE_URL` is configured, i.e. whether this
  deployment can hand out **public** (non-presigned) object URLs via
  `StorageService.buildPublicUrl`. Presence only, never the URL. It has **no
  effect on `ready` or `configPresent`**: a private bucket (no public
  access, no `r2.dev`, no custom domain) serves media exclusively through
  presigned PUT/GET and is fully ready with `publicDeliveryAvailable:
  false`. See "Private vs. public R2" above.
  **Omitted entirely in `local` mode** rather than reported as `false`:
  public object-storage delivery does not exist for that driver (nothing
  reads `OBJECT_STORAGE_PUBLIC_BASE_URL` there — the app serves bytes
  itself), so a hard-coded `false` would look like a degraded capability on
  a perfectly healthy local deployment, and a `true` from a stale `.env`
  line would be an outright false claim. Absent means "not applicable to
  this driver".

Booleans and the driver enum only — never the endpoint URL, bucket name,
region, access key, secret, or any absolute storage path. See
`docs/r2-readiness.md` for the full runbook.

## Media operations (Phase 11 — credential-free)

Two more Phase 11 building blocks live in this repo. Both are invoked
**programmatically only** — neither is wired to an HTTP route yet, and
neither makes a real network call in this credential-free slice.

### Thumbnail generation (work units 11D-2a / 11D-2b)

`ThumbnailService.generate(options)` (`src/thumbnails/thumbnail.service.ts`)
produces one representative frame from a source video and ingests it into
object storage:

1. Validates `options.inputPath` exists and is a file
   (`MEDIA_FILE_NOT_FOUND` if not) and has a supported extension — `.mp4`,
   `.mov`, `.mkv`, `.webm`, `.avi` (`UNSUPPORTED_MEDIA_FORMAT` if not).
2. Validates the requested capture offset (defaults to 3 seconds in;
   `INVALID_THUMBNAIL_TIMESTAMP` for a negative/non-finite override) and
   target width (defaults to 480px).
3. Delegates frame extraction to an injected `ThumbnailClient`
   (`THUMBNAIL_CLIENT` DI token, `src/thumbnails/thumbnail.types.ts`) inside
   a fresh `fs.mkdtemp` temp directory — the source file is only ever read,
   never written to, moved, or deleted.
4. Validates the returned artifact's dimensions
   (`THUMBNAIL_DIMENSION_MISMATCH` for a non-positive height, or a width
   that doesn't match what was requested).
5. Builds a deterministic object key, `thumbnails/{assetId}/{variant}.jpg`
   (`buildThumbnailStorageKey`,
   `src/thumbnails/thumbnail-storage-key.util.ts`) — the same `assetId` +
   width variant always resolves to the same key, so regenerating
   overwrites the same object instead of accumulating orphans.
6. Ingests the generated bytes via `StorageService.putObject(key, body,
   'image/jpeg')` (`src/storage/storage.service.ts`).
7. Removes the temp directory in a `finally` block on every path — success
   or failure — so a failed generation never leaves a stray temp file
   behind. Any unexpected error is wrapped as `THUMBNAIL_GENERATION_FAILED`
   and never leaks a raw filesystem path into the response.

`FfmpegThumbnailCliClient`
(`src/thumbnails/ffmpeg-thumbnail-cli.client.ts`) is the real
`ThumbnailClient` implementation — it shells out to the system `ffmpeg`
binary to extract the frame and to `ffprobe` to measure its actual
dimensions, mirroring the existing `ffprobe-cli.client.ts` pattern from the
11D-1 importer below. It is the **only** file in this slice that requires
`ffmpeg`/`ffprobe` to be installed: `thumbnail.service.spec.ts`'s primary
suite mocks `ThumbnailClient` and `StorageService` entirely (no `ffmpeg`
needed to run `npm test`), plus one optional integration test that
exercises the real client against a synthetic fixture and auto-skips when
`ffmpeg` is not found on `PATH`.

`ThumbnailsModule` (`src/thumbnails/thumbnails.module.ts`) is **not**
imported into `AppModule` — there is **no HTTP route** for thumbnail
generation in this slice; it is invoked programmatically (a future
importer/admin flow, or a CLI script) once wired up. `StorageService
.putObject` issues a real `PutObjectCommand` against the configured
S3-compatible bucket, but every current test mocks `StorageService`/its
underlying client — **the real object-storage upload is gated on R2
credentials (work unit 11D-2-real)**, matching the rest of this phase's
credential-free scope (see "Environment variables" above for the
`OBJECT_STORAGE_*` config this pipeline reads once real credentials exist).

### Dry-run importer (work unit 11D-1-dryrun)

`MediaDryRunService.inspect(folderPath, options?)`
(`src/importer/media-dryrun.service.ts`) is a strictly **read-only**
companion to the 11D-1 bulk importer (`MediaImporterService`,
`src/importer/media-importer.service.ts`): given one explicitly-passed
local folder, it reports what a real import **would** do, without
importing, writing, or moving anything.

- Lists the folder's top-level files (never recurses into subdirectories),
  filters to supported video extensions, and natural-sorts them (`1`, `2`,
  `10`, not the lexical `1`, `10`, `2`) to derive a proposed
  `episodeNumber`/`sortOrder` for each file.
- Probes each file's `durationSeconds`/`width`/`height` via the same
  injected `FfprobeClient` the real importer uses (`FFPROBE_CLIENT` token,
  `src/importer/importer.types.ts`), retrying up to `maxAttempts` (default
  3) before reporting a file as `probe_failed`.
- Reports each file's proposed storage key: its path relative to the
  passed `folderPath` — the same convention a real import would persist as
  `Video.storageKey`, computed relative to whatever folder root the caller
  passed in.
- Returns a `DryRunReport` (`src/importer/dryrun.types.ts`): `folderPath`,
  per-file `items[]` (each either `status: 'ok'` with ffprobe `metadata`,
  or `status: 'probe_failed'` with `attempts`/`error`), and
  `discoveredCount`/`succeeded`/`failed` totals.

**Safety guarantees** (see the class's own doc comment in
`media-dryrun.service.ts` for the full reasoning):

- **No database write of any kind.** `MediaDryRunService` does not inject
  `PrismaService` — it cannot read or write the database, structurally, not
  just by convention.
- **No upload.** It never calls `StorageService` or anything
  network-facing.
- **Never modifies, moves, renames, or deletes anything.** Its only
  filesystem calls are `fs/promises`'s `readdir` and `stat` — both
  read-only.
- **No default path, ever.** `folderPath` is a required call argument;
  there is no fallback to `STORAGE_ROOT` or any other directory
  (`DRY_RUN_FOLDER_PATH_REQUIRED` if omitted/blank,
  `DRY_RUN_FOLDER_NOT_FOUND` if it doesn't exist or isn't a directory).

Like `ThumbnailsModule`, `ImporterModule` (`src/importer/importer.module.ts`)
is **not** imported into `AppModule` — there is **no HTTP route** for
either `MediaDryRunService` or `MediaImporterService` in this slice. A real
run against a real company folder is a separate, **human-supervised,
explicitly-pathed** action (the future `11D-1-real` step) that — like
every other part of this phase — never touches `STORAGE_ROOT` originals.

### Building on prior work units

Both pieces build on patterns already established earlier in this phase:
the thumbnail pipeline reuses 11A-1's `StorageService`/S3-compatible-client
abstraction, and the dry-run importer mirrors 11D-1's ffprobe-backed
`MediaImporterService` (injected `FfprobeClient`, natural sort, retry/
failure reporting) without any of its database-writing side effects. Real
R2 wiring — actual uploads through `StorageService`, thumbnail ingestion to
a real bucket, and a real (non-dry-run) import against the company
library — remains gated behind R2 credential activation (11A-3 /
11D-2-real / 11D-1-real), same as the rest of this phase's credential-free
scope.

## Admin content management API (Phase 11, work units 11E-1..11E-4)

**Frozen contract:** `docs/admin-api-contract.md` is the authoritative,
frozen reference for this whole admin surface (work unit 11F-5, 2026-07-25)
— every route, DTO field, status code, and error code the Slice #4
admin-dashboard wiring (11F-6) and mobile docs (11F-7) target. This section
remains the narrative writeup; the frozen doc is the source of truth for
exact shapes.

Four admin-guarded routes across two controllers, layered on top of the
existing 11B-2/11B-3 admin auth-and-upload foundation described above.
Every route in this section requires **both** a valid access token
(`Authorization: Bearer <accessToken>`, `JwtAuthGuard`) **and** the
caller's `User.role` to be `"admin"` (`AdminGuard`, work unit 11B-2) —
`JwtAuthGuard` always runs first so `AdminGuard` can read `request.user`.
A missing/invalid/expired token returns `401 INVALID_ACCESS_TOKEN`; a
valid token belonging to a non-admin user returns `403
ADMIN_ROLE_REQUIRED`.

### `GET /admin/media`

The admin inventory list (work unit 11E-1) — unlike the public
`GET /videos/feed`, which only ever returns `published` rows, this returns
rows across **all five** lifecycle states (`draft`, `ready`, `published`,
`unpublished`, `failed`). Query params, all optional:

| Param | Type | Notes |
|---|---|---|
| `status` | one of the five lifecycle states | filters to that state; an invalid value returns a clean `400` |
| `seriesId` | string | filters to that series |
| `page` | integer, `>= 1` | default `1` |
| `pageSize` | integer, `1..100` | default `20` |

Returns `200`:

```json
{ "items": [ /* AdminMediaDto[] */ ], "total": 0, "page": 1, "pageSize": 20 }
```

Ordered deterministically by `sortOrder` then `id`, matching the existing
public-feed ordering convention. No schema change — this route only reads.

### `PATCH /admin/media/:id`

A partial metadata edit (work unit 11E-2). Body (`UpdateMediaMetadataDto`)
accepts any subset of these seven fields, each mirroring the same
`class-validator` constraint the original `POST /admin/media` create route
already applies:

- `title` (string, 1–200 chars)
- `caption` (string, 1–2000 chars)
- `category` (one of the four canonical values — see "`Video.category` —
  canonical set" above; work unit "Episode Access-Tier + Category Contract
  Hardening" narrowed this from freeform 1–100 chars to a closed `@IsIn`
  set — an unrecognised value now returns a clean `400`)
- `channelName` (string, 1–200 chars)
- `sourceLanguage` (string, 1–20 chars)
- `episodeNumber` (integer, `>= 1`)
- `hasEmbeddedIndonesianSubtitle` (boolean)

At least one field must be present — an empty body returns `400
EMPTY_MEDIA_METADATA_UPDATE`. Every other `Video` column
(`lifecycleState`, the object-storage/cover/thumbnail keys, `storageKey`,
`sortOrder`, `likeCount`, `durationSeconds`/`width`/`height`,
`accessTierOverride`) is immutable via this route: the global
`ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` rejects
a body containing any of them (or any other unrecognized field) with a
`400` before the service is even called, and the service applies a
second, independent whitelist as defense-in-depth. An unknown `id`
returns `404 VIDEO_NOT_FOUND`. Returns `200` with the updated
`AdminMediaDto`.

### `PATCH /admin/media/:id/access-tier`

Sets or clears a per-episode access-tier override (work unit 11E-3, made
the explicit DB-backed source of truth by 11F-4 — see below). Body:

```json
{ "tier": "free" }
```

`tier` is **required** and must be exactly one of `"free"`, `"premium"`,
or `null`:

- `"premium"` — this episode always requires an active entitlement,
  regardless of `episodeNumber`.
- `"free"` — this episode always streams without an entitlement,
  regardless of `episodeNumber`.
- `null` — clears the override, reverting the row to `null` until the
  next backfill/create/reseed sets it explicitly again (see below) — in
  practice this means the row falls back to the
  `episodeNumber > FREE_EPISODE_LIMIT` derivation the very next time it's
  read, via `EntitlementsService.resolveEpisodePremium`'s null-safety
  fallback.

Persisted on the additive `Video.accessTierOverride` column (nullable
`String?`, no default — added by a single-column `ADD COLUMN` migration
with no drop/default/backfill/data change). An invalid/missing `tier`,
or any non-whitelisted extra field, returns a clean `400`; an unknown
`id` returns `404 VIDEO_NOT_FOUND`. Returns `200` with the updated
`AdminMediaDto` — `accessTierOverride` is exposed only on this
admin-only DTO, never on the public `VideoResponseDto`. A PATCH here is
immediately reflected on `AdminMediaDto.accessTier` (this route's own
response) **and** on the public `VideoResponseDto.accessTier` field
(`GET /videos/feed`/`GET /videos/:id`/`GET /series/:id`) the very next
time that episode is read — both are computed by the same
`resolveAccessTier` function, so there is no propagation delay or
separate cache to invalidate.

**Explicit DB-backed access tier (work unit 11F-4).** Every `Video` row
now carries an explicit `"free"` or `"premium"` value in this column,
not just rows an admin has manually touched:

- **Backfill migration** (`prisma/migrations/*_backfill_video_access_tier_override`,
  data-only, additive, no DDL change): a one-time `UPDATE ... WHERE
  "accessTierOverride" IS NULL` that filled every previously-`NULL` row
  (all 40 pre-existing rows, at the time it ran) with the value the old
  default rule already derived for it (`episodeNumber >
  FREE_EPISODE_LIMIT` → `"premium"`, else `"free"`). The `WHERE ... IS
  NULL` guard means it can never touch a row that already had an
  explicit override set via this endpoint. Reversible (re-nulling the
  column fully undoes it, since the underlying `episodeNumber` values are
  never modified).
- **`prisma/seed.ts`** now sets `accessTierOverride` to the same derived
  value on every freshly-created (not re-updated) seed row, so a fresh
  `prisma migrate reset` + seed also yields explicit tiers rather than
  relying on the one-time migration alone.
- **`POST /admin/media`** (`createUpload`) now derives and sets an
  explicit tier from the submitted `episodeNumber` at creation time, so
  every newly admin-created row also starts with a non-null tier. This
  endpoint's own `PATCH .../access-tier` above remains the only way to
  set a tier that intentionally disagrees with `episodeNumber`.
- **Enforcement reads the DB value.** `EntitlementsService
  .resolveEpisodePremium` (used by the `GET /videos/:id/stream` guard)
  treats `accessTierOverride = "premium"`/`"free"` as authoritative
  regardless of `episodeNumber` — this was already true since 11E-3, and
  after the 11F-4 backfill it applies to every real row, not just
  admin-touched ones. `episodeNumber`-based derivation
  (`isEpisodePremium`) is retained only (a) as the value the
  backfill/seed/create-time default derives from, and (b) as a
  null-safety fallback for a row that is somehow still `null` (there
  should be none post-backfill, since the column has no `NOT NULL`
  constraint). In other words: **premium access is no longer derived
  solely from `episodeNumber` at request time** — it is read from
  `Video.accessTierOverride`, which every row now carries explicitly.
- **Existing-row gating is unchanged.** For all 40 pre-existing rows the
  backfilled DB value is, by construction, identical to what the old
  `episodeNumber`-only rule already produced — this changes only what is
  *stored*, never the streaming/entitlement *outcome* for any row that
  predates this work unit.

### `GET` / `POST` / `PATCH` / `DELETE /admin/series`, archive/unarchive

A lightweight, **additive** `Series` metadata model (work unit 11E-4;
extended in 11F-1 with read-detail, safe archive/unarchive, and a guarded
hard delete) — a new Prisma table, not an extension of `Video`. Purely
optional annotation of an existing `Video.seriesId` grouping: there is no
database-level FK from `Video` to `Series`, and `GET /videos/feed`'s
grouping/playback and the public `VideoResponseDto` shape are completely
unaffected.

| Field | Type | Notes |
|---|---|---|
| `id` | string, 1–200 chars | the existing plain-string `seriesId` convention (e.g. `"series-104"`); client-provided on create, immutable afterward |
| `title` | string, 1–200 chars | required on create |
| `coverImageKey` | string, 1–500 chars, optional | |
| `sortOrder` | integer, `>= 0`, optional | defaults to `0` |
| `createdAt` / `updatedAt` | ISO-8601 timestamps | server-managed |
| `archivedAt` | ISO-8601 timestamp or `null` | work unit 11F-1; `null` = active. Set/cleared only via the archive/unarchive routes below. |

- **`GET /admin/series`** — returns `200` with `Series` rows as
  `SeriesWithCoverDto[]` (`SeriesDto` + a signed `coverUrl`, 2026-08-14
  re-freeze), ordered by `sortOrder` then `id`. **Excludes archived rows
  by default** (work unit 11F-1) — pass `?includeArchived=true` (a
  validated boolean; any value other than exactly `true`/`false`,
  case-insensitive, is rejected with `400`) to include them too.
- **`GET /admin/series/:id`** — work unit 11F-1 read-detail. Returns `200`
  with the `SeriesWithCoverDto` (archived or not, episode-less or not), or
  `404 SERIES_NOT_FOUND` for an unknown id.
- **`POST /admin/series`** — body `{ "id", "title", "coverImageKey"?,
  "sortOrder"? }`. Returns `201` with the created `SeriesDto` (the plain
  shape). A duplicate `id` returns a clean `409 SERIES_ALREADY_EXISTS`
  (pre-checked, and also caught if a race loses to a raw Prisma
  unique-constraint violation) rather than an unstructured 500.
- **`PATCH /admin/series/:id`** — a partial edit: any subset of `title`,
  `coverImageKey`, `sortOrder` (same constraints as create). `id` itself
  is not accepted in the body (rejected by the global whitelist — it is
  immutable). At least one field must be present, or `400
  EMPTY_SERIES_UPDATE`. An unknown `id` returns `404 SERIES_NOT_FOUND`.
  Returns `200` with the updated `SeriesDto` (the plain shape).
  **`coverImageKey` (2026-08-14 re-freeze): three explicit states** —
  omitted (unchanged), `null` (explicitly clears the cover — the only way
  to remove one), or a non-empty string (sets/replaces the raw key,
  unverified — prefer the upload flow below for real uploads). **Fix cycle
  1 (2026-08-15):** an explicit `null` ALSO clears the private
  `pendingCoverImageKey` column in the same write, invalidating any
  upload that was still in flight — see the `.../cover/complete` entry
  below.
- **`POST /admin/series/:id/cover`** (NEW, 2026-08-14 re-freeze) — presign
  a cover-image upload. Body `{ "contentType", "sizeBytes" }`, both
  required: `contentType` is one of `image/jpeg`/`image/png`/`image/webp`
  (closed allow-list); `sizeBytes` is `1`–`10485760` (10 MiB). Returns
  `201 { "upload": { "url", "key", "expiresAt" } }` — the object key is
  entirely server-generated (`admin-series/<seriesId>/cover/<uuid>`, the
  client never chooses one) and nothing is persisted on the PUBLIC
  `Series.coverImageKey`/`coverUrl` yet. An unknown `id` returns
  `404 SERIES_NOT_FOUND`. **Fix cycle 1 (2026-08-15):** DOES record the
  minted key into the private `Series.pendingCoverImageKey` column (latest
  mint overwrites any earlier pending one) — internal upload-intent
  bookkeeping only, never exposed on any response DTO; see below.
- **`POST /admin/series/:id/cover/complete`** (NEW, 2026-08-14 re-freeze;
  currency check ADDED 2026-08-15, fix cycle 1) —
  body `{ "key" }` (the key the presign step returned). Verifies, in
  order: the series exists; `key` belongs to THIS series' cover prefix and
  has the right shape (`400 SERIES_COVER_KEY_INVALID` otherwise); **`key`
  equals the series' current `pendingCoverImageKey` (normal path) or its
  current `coverImageKey` (idempotent no-op success) — any other
  well-formed key is a superseded/stale/replayed key from an earlier
  generation and is rejected with `409 SERIES_COVER_KEY_SUPERSEDED`
  (fix cycle 1)**; the object actually exists (`400 MEDIA_FILE_NOT_FOUND`
  otherwise); its real content type is allowed (`409
  SERIES_COVER_CONTENT_TYPE_NOT_ALLOWED` otherwise); its real size is
  within bound (`409 SERIES_COVER_SIZE_OUT_OF_BOUND` otherwise). Only then
  persists `Series.coverImageKey`, clears `pendingCoverImageKey`, and
  returns `200 SeriesWithCoverDto`. **Hardening (2026-08-18):** that final
  write is an atomic compare-and-set — it applies only while
  `pendingCoverImageKey` still equals `key`, so a completion superseded
  during verification writes nothing and gets the same
  `409 SERIES_COVER_KEY_SUPERSEDED`. Idempotent on a repeated call with the
  already-live key (including when the duplicate is simultaneous rather
  than sequential). **Replace semantics:** the OLD cover stays
  authoritative until a NEW upload is fully verified — a failed
  verification never clears or overwrites it. **Content-Type/Length are
  not cryptographically bound by the presigned PUT itself** — a caller
  could label non-image bytes with an allowed `Content-Type`; the
  authoritative check happens here, against R2's own HEAD-reported
  metadata, not against magic bytes (real content-sniffing is documented
  future hardening, not implemented). **Orphans:** the previous object is
  never auto-deleted from R2 when replaced, and a presigned-but-
  never-completed (or failed-verification) upload also leaves an orphan
  object in R2 — neither case is automated cleanup today (documented, not
  implemented — a bounded janitor sweep mirroring
  `TranscodeJanitorService` is the recommended future hardening; see
  `docs/admin-api-contract.md` for the full detail).
- **`POST /admin/series/:id/archive`** — work unit 11F-1: safe (soft)
  archive, the PRIMARY "delete" action — sets `archivedAt` to now. No data
  loss, fully reversible via `unarchive`. **Idempotent**: calling it again
  on an already-archived series is a no-op (returns the row unchanged, no
  timestamp drift). Returns `200` with the (now-archived) `SeriesDto`. An
  unknown `id` returns `404 SERIES_NOT_FOUND`.
- **`POST /admin/series/:id/unarchive`** — reverses `archive` by clearing
  `archivedAt`. Idempotent the same way. Returns `200` with the
  `SeriesDto`. An unknown `id` returns `404 SERIES_NOT_FOUND`.
- **`DELETE /admin/series/:id`** — work unit 11F-1: the guarded HARD
  delete — actually removes the `Series` metadata row. Before deleting,
  counts `Video` rows sharing this `seriesId` with
  `lifecycleState: "published"`; if that count is greater than zero, the
  delete is **refused** with `409 SERIES_HAS_PUBLISHED_EPISODES` and
  nothing is written. This is the only `Series` route that reads the
  `Video` table, and it is read-only (a count) — a successful delete never
  touches, updates, or deletes any `Video` row, so every episode's
  `seriesId` and every other field is preserved exactly. Returns `204 No
  Content` on success; an unknown `id` returns `404 SERIES_NOT_FOUND`. For
  a series that still has published episodes, prefer `archive` instead —
  it is always available and has no such restriction.

No new environment variables were needed for this work unit — every route
reads/writes the existing `DATABASE_URL` Postgres connection only.

## Ads config API (Phase 15A, slice 15A-S1)

`GET /config/ads` is a **public, unauthenticated** route that returns the
current interstitial-ad frequency configuration, consumed by the mobile
app's ad-gating logic at launch (frozen contract recorded in the control
workspace's `DECISIONS.md`, "2026-08-03 — Phase 15A slice S1 APPROVED...",
commit `0f75033`). No `Authorization` header is required or checked, and the
response is the exact top-level object below — **not** wrapped in this
project's usual `{ success, data, error }` envelope:

```json
{
  "enabled": true,
  "minVideosBetweenAds": 3,
  "maxVideosBetweenAds": 6,
  "minSecondsBetweenAds": 120,
  "graceVideos": 5
}
```

| Field                  | Meaning                                                                |
| ---------------------- | ------------------------------------------------------------------------ |
| `enabled`              | Whether the interstitial-ad system is on at all.                       |
| `minVideosBetweenAds`  | Lower bound of the randomized `[min, max]` watched-video threshold re-rolled after each shown ad. |
| `maxVideosBetweenAds`  | Upper bound of that same range.                                        |
| `minSecondsBetweenAds` | Cooldown, in seconds, between shown ads. The cooldown **holds** the watched-video counter — it never resets it. |
| `graceVideos`          | Number of lifetime video watches, from a fresh install, that never count toward the threshold. |

Backed by five optional environment variables (`AdsConfigService`, read once
at process start): `ADS_INTERSTITIAL_ENABLED`, `ADS_MIN_VIDEOS_BETWEEN_ADS`,
`ADS_MAX_VIDEOS_BETWEEN_ADS`, `ADS_MIN_SECONDS_BETWEEN_ADS`,
`ADS_GRACE_VIDEOS` — see the "Environment variables" table above and
`.env.example` for the exact defaults (`enabled=true`, `min=3`, `max=6`,
`seconds=120`, `grace=5`). None of them are required at boot:

- Unset falls back to that field's default silently.
- A non-numeric or negative value for any of the four integer fields falls
  back to that field's own default and logs a `warn` naming the variable
  (never its value).
- `ADS_INTERSTITIAL_ENABLED` accepts exactly `"true"`/`"false"`; any other
  value falls back to `true` and logs a `warn`.
- If, after parsing, `minVideosBetweenAds > maxVideosBetweenAds`, **both**
  revert to their defaults and a `warn` is logged — never a boot failure and
  never a half-sanitized range served to a client.

This is a coarse, non-secret tuning surface — a boolean and four small
integers, no credential, path, or user data — so it is safe to serve to any
anonymous caller. Like every other route in this app, it inherits the
global `ThrottlerGuard`'s default rate limit (`DEFAULT_THROTTLE_LIMIT`/
`DEFAULT_THROTTLE_TTL_MS` in `src/common/rate-limit.constants.ts`, 300
requests/60s per IP) with no per-route override. No schema change, no
migration, and no new dependency were introduced for this slice.

## HLS transcode queue foundation (Slice 11N)

Data-model + queue FOUNDATION only — no FFmpeg, no HLS, no worker process.
Approved per control workspace `DECISIONS.md`, "2026-08-10 — Slice 11N
APPROVED..."; architecture: `proposals/phase-11-hls-pipeline-proposal.md`
§7–§8.

**Schema (additive, reversible):** `Video` gains exactly two nullable/
defaulted columns — `processingState String?` (`null` = no processing
pipeline for this row, the permanent state for every legacy/local row;
otherwise app-layer-validated `"queued" | "running" | "ready" | "failed"`,
NOT a Postgres enum) and `processingVersion Int @default(0)` (a monotonic,
per-row CAS token). Migration:
`prisma/migrations/*_add_processing_state_and_version`, applied to both
`short_drama_dev` and `short_drama_test`. **Rollback:** drop the pair
(`ALTER TABLE "Video" DROP COLUMN "processingState", DROP COLUMN
"processingVersion";` and `DROP INDEX "Video_processingState_idx";`) — safe
at any time, since nothing outside this slice reads either column yet.
**No `MediaProcessingJob` table was created** — this slice's Redis-loss
recovery works entirely off `Video.processingState = "queued"` via
`TranscodeReconcilerService`; a durable per-attempt history table is
deferred to whichever future slice (11O+) first needs one, per the approval's
schema-minimality constraint.

**Feature flag:** `TRANSCODE_ENABLED` must be the exact string `"true"` to
activate anything — unset, empty, `"TRUE"`, `"1"`, or any other value all
resolve to `false` (fail-closed). `false` is this repository's shipped
default everywhere; `TRANSCODE_ENABLED=true` is a hard prohibition outside
explicitly-scoped, queue-mocking tests. `REDIS_URL` is required (by
`env.validation.ts`, name/shape only, never a network probe) only when the
flag is `true`; while it is `false`, `REDIS_URL`'s absence — or Redis never
having been installed at all — is completely harmless: no Redis client is
ever constructed.

**Queue module (`src/transcode/`):** `TranscodeIntentService.requestProcessing`
does a single atomic Prisma update (`processingVersion: { increment: 1 }`,
`processingState: "queued"`) — DB write first — then best-effort enqueues a
`{ videoId, processingVersion }` payload onto the BullMQ `media-transcode`
queue with jobId `"<videoId>:<processingVersion>"` (dedupe); an
enqueue/Redis failure is caught, logged (redacted) at `warn`, and never
thrown — the DB row stays durably `"queued"`.
`TranscodeIntentService.transitionIfVersion` is the generic CAS primitive
(`updateMany` guarded on `processingVersion`) every future worker must use.
`TranscodeReconcilerService.reconcile(limit = 25)` re-enqueues rows still
`"queued"` with their CURRENT version — idempotent (same jobId), bounded,
never mutates state, never deletes anything, and is a no-op while the flag is
off. No cron/scheduler wiring in this slice — that arrives with the worker
slice that will actually consume these jobs.

**Enqueue point:** `POST /admin/media/:id/complete-upload`
(`AdminMediaService.completeUpload`), AFTER the existing 11L
HEAD/size/type verification and the `ready` lifecycle transition succeed,
calls `requestProcessing` IF AND ONLY IF `TRANSCODE_ENABLED=true`. With the
flag `false` (this slice's only shipped state), `completeUpload`'s behavior
is byte-for-byte unchanged from before this slice.

**Readiness:** `GET /health/details` (dev-tools-gated, per the existing
11G-4 pattern) gains a `transcode` field — `{ enabled: false }` only while
the flag is off (transcode readiness is not required for overall app
readiness in that state), or `{ enabled: true, configPresent, ready }`
(config-presence only, never a live Redis probe) while it is on. Never
`REDIS_URL`'s value, a credential, a host, or a port.

**New dependencies:** `bullmq` (the requested addition) plus `ioredis`,
which had to be installed explicitly too — despite the original plan
assuming it would come in transitively, `bullmq@6`'s own code
unconditionally `require()`s `ioredis` at module-load time (it is listed as
an *optional peer* dependency in `package.json`, but is not actually
optional at the code level for the default Queue/Worker backend), so
merely importing anything from `bullmq` throws `Cannot find module
'ioredis'` without it installed — confirmed empirically before deciding to
add it.

## Production transcoding lifecycle (Slice 11P)

Approved per control workspace `DECISIONS.md`, "2026-08-10 — Slice 11P
APPROVED..."; architecture: `proposals/phase-11-hls-pipeline-proposal.md`
§6–§8, §14. Turns the Slice 11O proven local FFmpeg/HLS pipeline into a
production consume path: real worker job processing, versioned/immutable
output + atomic pointer flip, bounded retry with backoff, crash/stalled
recovery, grace-aware orphan cleanup, and a publish gate — production
transcoding stays **disabled by default** throughout (`TRANSCODE_ENABLED`
still ships `false` everywhere real).

### Schema (additive, reversible)

`Video` gains 13 nullable/defaulted columns, all written EXCLUSIVELY by this
slice's code (never by 11N/11O): `hlsMasterKey String?` (the live pointer —
written only by the promotion CAS), `processingStep String?` (display-only
progress detail within `running`), `processingErrorCode String?` /
`processingErrorMessage String?` (bounded, secret-free failure detail),
`processingAttempts Int @default(0)` (per-generation retry counter),
`processingStartedAt DateTime?` / `processingCompletedAt DateTime?`
(telemetry timestamps), `sourceWidth Int?` / `sourceHeight Int?` /
`sourceDurationSeconds Int?` / `sourceFps Float?` (persisted `ffprobe`
results), `hlsRenditions Json?` (`[{name,width,height,bandwidth}]` for the
CURRENT generation only), `transcodeProfileVersion String?` (e.g.
`"ladder-v1"`, written at promotion). Migration:
`prisma/migrations/20260810103917_add_transcode_lifecycle_columns`, applied
to both `short_drama_dev` and `short_drama_test` — post-migration row-safety
verified on both (every new column null/0 on every pre-existing row).

**No `MediaProcessingJob` table** — re-affirming 11N's schema-minimality
decision: per-attempt history is the columns above plus structured logs;
Redis-loss recovery is `TranscodeReconcilerService` (11N, unchanged);
stalled-job detection is `processingStartedAt` + `TRANSCODE_STALLED_AFTER_MINUTES`.

**Rollback:** additive-only, safe to drop at any time (nothing outside this
slice reads any of these columns):

```sql
ALTER TABLE "Video"
  DROP COLUMN "hlsMasterKey",
  DROP COLUMN "processingStep",
  DROP COLUMN "processingErrorCode",
  DROP COLUMN "processingErrorMessage",
  DROP COLUMN "processingAttempts",
  DROP COLUMN "processingStartedAt",
  DROP COLUMN "processingCompletedAt",
  DROP COLUMN "sourceWidth",
  DROP COLUMN "sourceHeight",
  DROP COLUMN "sourceDurationSeconds",
  DROP COLUMN "sourceFps",
  DROP COLUMN "hlsRenditions",
  DROP COLUMN "transcodeProfileVersion";
```

### The resolved swallowed-intent concern (carried from 11N/11O)

`AdminMediaService.completeUpload` now performs the ready-transition AND the
durable processing intent write (`TranscodeIntentService.recordIntent` —
`processingVersion` increment + `processingState="queued"` + attempts/step/
error fields reset) inside ONE `prisma.$transaction`. Either BOTH commit or
NEITHER does: a durable-intent failure throws `500
MEDIA_PROCESSING_INTENT_FAILED` and the row stays exactly `draft` — never
silently treated as scheduled, and never left "ready but never queued".
Idempotency is unchanged: `MediaLifecycleService.assertTransition` already
guarantees this block only runs on a genuine `draft -> ready` transition, so
a retried `complete-upload` call against an already-`ready` row still 400s
before the transaction is ever opened — no double-increment. Enqueue stays
POST-COMMIT and best-effort (`TranscodeIntentService.enqueueBestEffort`) — a
Redis/enqueue failure after a committed intent is recovered by the existing
11N `TranscodeReconcilerService.reconcile` sweep. **Flag off (this repo's
only shipped state) is byte-identical to pre-11P behavior** —
`admin-media.service.spec.ts`/`admin-media-transcode.spec.ts` are completely
unmodified and still green. See
`src/media/admin-media-transcode-intent-failure.spec.ts` for the dedicated
regression coverage.

### Worker consume path

`TranscodeJobProcessor.process({videoId, processingVersion})`
(`src/transcode/transcode-job-processor.service.ts`) is the real per-job
logic, framework-agnostic (no BullMQ import) so every test calls it directly
with fakes:

1. Load the row; abort `superseded` if it no longer exists, the version no
   longer matches, or it is not currently `"queued"`.
2. `TranscodeIntentService.claimRunning` — CAS `queued -> running`
   (version+state guarded), setting `processingStartedAt`, incrementing
   `processingAttempts`, clearing prior error fields.
3. Attempt-cap check: over `TRANSCODE_MAX_ATTEMPTS` CAS-fails immediately
   with `MAX_ATTEMPTS_EXCEEDED` — no FFmpeg work starts.
4. Download `admin-media/<id>/source` (`StorageService.downloadObjectToFile`,
   new narrow bounded method) to a fresh temp dir — `SOURCE_MISSING` on
   failure.
5. Probe (`HlsProbeClient`, Slice 11O) — `PROBE_FAILED` on failure; persist
   via `TranscodeIntentService.recordSourceProbe` (also the first
   post-download supersede checkpoint).
6. Compute the ladder (`computeRenditionLadder`, Slice 11O, unchanged).
7. Transcode every rung (`HlsTranscodeService.transcodeAll`, Slice 11O,
   unchanged, extended with an optional `onRungStart` hook this slice added
   for per-rung `processingStep` updates, e.g. `"360p"`) — one rung failing
   fails the whole job (`TRANSCODE_FAILED`); a supersede detected mid-loop
   aborts immediately.
8. Build + write `master.m3u8` locally (`MasterPlaylistService`, unchanged).
9. Upload every artifact to the fresh, immutable, UNIQUE staging prefix
   `admin-media/<id>/hls/v<version>-a<attempt>-<uuid>/`
   (`buildHlsStagingPrefix`), tracking every successfully uploaded key as it
   happens (a mid-upload crash cleans up exactly what succeeded, never a
   broad/prefix delete).
10. Locally re-validate (`HlsPackageValidator`, unchanged) AND
    bounded-HEAD-verify every uploaded key — either failure cleans up
    staging and CAS-fails the row (`HLS_PACKAGE_VALIDATION_FAILED` /
    `UPLOAD_VERIFICATION_FAILED`); neither ever reaches promotion.
11. Poster: only if the row has no `thumbnailImageKey` yet — generates via
    the injected `ThumbnailClient` (the same ffmpeg-backed client
    `ThumbnailsModule` already provides) and uploads to
    `admin-media/<id>/thumbnail` (`buildThumbnailObjectKey` — the SAME key
    `AdminMediaService.createThumbnailUpload`'s manual-upload flow uses). A
    poster failure FAILS THE WHOLE JOB (frozen arch: publish needs a
    poster). An existing poster is never regenerated.
12. FINAL ATOMIC PROMOTION (`TranscodeIntentService.promoteIfCurrent`) — the
    ONLY write path for `hlsMasterKey`/`hlsRenditions`/
    `transcodeProfileVersion`, version+state guarded. `0` rows affected ⇒
    superseded at the last moment: does NOT promote, cleans this job's OWN
    staging, and NEVER touches whatever generation is now live.

Live/current generation is never written to or deleted by a job at any
point.

### Retry / backoff

Bounded at `TRANSCODE_MAX_ATTEMPTS` (default 3) — enforced at TWO
independent layers: BullMQ's own `attempts`/`backoff` job options (set at
enqueue time by `BullmqTranscodeQueueClient.add`, exponential off a 60 s
base — `TRANSCODE_BACKOFF_BASE_DELAY_MS`) drive redelivery timing, while
`TranscodeJobProcessor`'s own `processingAttempts` DB counter + cap check is
the AUTHORITATIVE source of truth for whether a generation is done retrying
— decoupled on purpose, so a BullMQ-level/DB-level mismatch is harmless (an
extra redundant delivery after the DB cap is hit is a cheap, idempotent
`NOT_QUEUED` no-op). A non-final attempt failure uses
`TranscodeIntentService.requeueForRetry` (`running -> queued`, NOT
`processingAttempts`-reset) so the row is claimable again; the FINAL allowed
attempt failing uses the terminal `failWithError` (`running -> failed`)
instead, preserving the real failure reason rather than a generic
`MAX_ATTEMPTS_EXCEEDED` on a wasted extra cycle.
`src/worker/transcode-worker.ts`'s thin BullMQ `Worker` wiring decides, per
delivery, whether to resolve (done) or re-throw (let BullMQ redeliver) based
on `TranscodeJobOutcome.terminal` — see `shouldRethrowForBullMqRetry`.
Retry NEVER re-uploads the source (it still exists in R2); every retry gets
a brand-new immutable staging prefix (`v<version>-a<attempt>-<uuid>`, a
fresh `attempt` number AND a fresh `randomUUID()`).

### Crash / stalled recovery

- **Worker process crash mid-job:** the row is left `"running"`.
  `TranscodeJanitorService.sweepStaleRunning` (bounded, idempotent,
  flag-gated) finds rows `"running"` longer than
  `TRANSCODE_STALLED_AFTER_MINUTES` (default 30) and CAS-fails them
  (`STALE`) — recoverable via a fresh processing request. This is a
  DB-level backstop distinct from (and not replaced by) BullMQ's own
  `stalledInterval` reclaim mechanism, which cannot cover total Redis data
  loss.
- **R2 upload failure / partial upload:** caught, staging cleaned via the
  in-memory `uploadedKeys` list, row CAS-failed/requeued — the live
  generation is untouched (proof 5, exercised by simulating a `putObject`
  throw mid-upload in `transcode-job-processor.service.spec.ts`).
- **Episode/row superseded mid-run** (a newer `requestProcessing` call bumped
  the version): every CAS checkpoint in the pipeline detects this (affected
  count 0) and aborts immediately, cleaning up its own staging.

### Immutable prefix + pointer-flip model

Every attempt writes to a brand-new, uniquely-named prefix
(`src/transcode/hls-staging-key.util.ts`); the live set is identified ONLY
by `Video.hlsMasterKey`, flipped by exactly one version+state-guarded CAS
(`promoteIfCurrent`). Nothing is ever promoted by copying, and the published
set is never overwritten in place — a partial/failed generation can
structurally never become visible.

### Cleanup / grace policy

`TranscodeJanitorService.cleanupOrphanStaging` (bounded, idempotent,
flag-gated, never destructive to live output): for TERMINAL rows
(`processingState` `"ready"`/`"failed"`), lists objects under
`admin-media/<id>/hls/` (`StorageService.listObjectKeysByPrefix`, new narrow
bounded method — `ListObjectsV2`, single page), groups by generation prefix,
and deletes any generation that is (a) NOT the active generation (derived
from `hlsMasterKey`, a STRUCTURAL exclusion — the active prefix is never
even considered a deletion candidate) AND (b) whose newest object is older
than `TRANSCODE_CLEANUP_GRACE_MINUTES` (default **120** minutes —
**deliberately longer** than the future 11Q playback-token TTL design target
of 30–60 minutes, so a generation a viewer may still hold a live
authorization token for is never deleted out from under them). Never
touches `source`/`cover`/`thumbnail` keys (prefix-scoped to `hls/` only). A
per-object delete failure is logged loudly and does not abort the rest of
the sweep; an unswept object is picked up again on the next sweep.
**Scheduling:** follows the Phase 13 (13A-B2) `RetentionSchedulerService`
precedent (env-gated, OFF by default, the injectable methods are the real
foundation) — reuses `TRANSCODE_ENABLED` itself as the single schedule gate
(no second env var) rather than inventing one purely to control "does the
interval exist" on top of a feature that is already off by default; the
persistent worker mode below registers a `setInterval` sweep every 5
minutes (`TRANSCODE_JANITOR_INTERVAL_MS`) only while it is running.

### Publish gate

`AdminMediaService`'s publish transition gains one additive guard
(`assertHlsReadyForPublish`), checked ONLY for rows where
`processingState IS NOT NULL` (an HLS-pipeline row): such a row may only
publish once `processingState === "ready"` AND `hlsMasterKey` is non-null,
or it is refused with `409 HLS_NOT_READY_FOR_PUBLISH`. Rows with
`processingState === null` — every legacy/local row, and the pre-HLS
published R2 fixture row — are completely unaffected; their publish/
unpublish behavior is byte-identical to before this slice. See
`src/media/admin-media-publish-gate.spec.ts`.

### Persistent worker mode

`src/worker/main.ts`'s `bootstrapWorker` now branches on
`TRANSCODE_ENABLED`: `false` (default smoke mode, unchanged from Slice 11O)
boots, logs readiness, closes, and exits `0`; `true` (isolated test/dev
conditions only) starts the real BullMQ transcode worker
(`src/worker/transcode-worker.ts`, concurrency 1) plus the periodic janitor
sweep, and keeps the process alive until `SIGTERM`/`SIGINT` triggers a
graceful shutdown. `WorkerModule` is a dynamic module
(`WorkerModule.register()`): it reads `TRANSCODE_ENABLED` BEFORE building
its `imports` and only includes `PrismaModule`/`TranscodeModule` (needed
for `TranscodeJobProcessor`/`TranscodeJanitorService`'s real DB access in
persistent mode) when the flag is exactly `true`. In the default flag-off
smoke mode those modules are absent from the module graph entirely, so the
boot has ZERO database dependency — it exits `0` even when `DATABASE_URL`
is unreachable (the Slice 11O invariant, restored and regression-tested in
`worker.module.spec.ts` after review fix cycle 1).

### Config (`TRANSCODE_MAX_ATTEMPTS` / `TRANSCODE_STALLED_AFTER_MINUTES` / `TRANSCODE_CLEANUP_GRACE_MINUTES`)

All three OPTIONAL, mirroring the 11G-3 conditional-validation pattern: each
has a documented default (3 / 30 / 120) and is read unconditionally by
`configuration.ts`'s factory, but `env.validation.ts` only rejects a
PRESENT-but-invalid (non-positive-integer) value, and only while
`TRANSCODE_ENABLED=true`. See `.env.example` for placeholders.

### Observability

Structured, secret-free logs (via the existing `redactSensitiveText` layer)
for: job accepted (attempt/max), per-step transitions, per-rung
`processingStep` updates, promotion/failure/supersede outcomes with wall-
clock duration, janitor actions (stale-run age, cleanup counts), and cleanup
failures (always logged loudly, never silently swallowed). Every persisted
`processingErrorMessage` is redacted AND length-bounded before it ever
reaches the database — never a raw, unredacted exception message or stack
trace (see `transcode-job-processor.service.spec.ts`'s dedicated sentinel
test).

## Private HLS Delivery Gateway (Slice 11Q)

Control-workspace DECISIONS.md "2026-08-10 — Slice 11Q APPROVED..." entry;
architecture: `proposals/phase-11-hls-pipeline-proposal.md` §9/§9a. A small
Cloudflare Worker (`workers/hls-gateway/`, a fully independent npm package —
own `package.json`/`node_modules`, not an npm workspace of this repo) serves
private R2-backed HLS media via one short-lived, content/version-bound
playback token, so the backend never proxies media bytes and R2 credentials
are never exposed to a client. **Not deployed anywhere by this slice** — only
`workers/hls-gateway/wrangler.toml.example` exists (a template); there is no
real `wrangler.toml`, and this slice never runs `wrangler login`/`deploy`.

### Token v1 (shared backend↔Worker contract)

```
payload = base64url(JSON.stringify({ v: 1, m: mediaId, p: authorizedPrefix, e: unixExpirySeconds }))
sig     = base64url(HMAC-SHA256(secret, payload))
token   = `${payload}.${sig}`
```

Minted by `src/transcode/hls/hls-playback-token.util.ts#mintHlsToken` (Node
`crypto.createHmac`), verified by `workers/hls-gateway/src/token.ts#verify`
(WebCrypto `crypto.subtle`, constant-time via `subtle.verify`). Deliberately
**no `userId` claim** — the token is content/version-bound, not
identity-bound; the backend's own `GET /videos/:id/playback` request (already
authenticated + entitlement-checked before a token is ever minted) is the
audit trail for "who played what, when". `authorizedPrefix` is the exact
immutable HLS generation prefix derived from `Video.hlsMasterKey` (everything
up to and including the final `/` before `master.m3u8`, e.g.
`admin-media/<id>/hls/v3-a1-<uuid>/`) via `deriveActiveGenerationPrefix`
(reused from Slice 11P's `hls-staging-key.util.ts`), cross-checked against
the row's own `mediaId` so a malformed/mismatched key can never mint a token
for the wrong media. TTL default 60 min (`HLS_TOKEN_TTL_SECONDS`, NOT frozen —
2026-08-10 approval: "design target 30-60 min; the final TTL must be
validated by real playback QA"). The shared regression fixture
`workers/hls-gateway/test/token-vectors.json` (synthetic secret/media
ids/fixed reference clock) is asserted against by BOTH
`src/transcode/hls/hls-token-contract.spec.ts` (backend mint reproduces every
vector byte-for-byte) and `workers/hls-gateway/test/token.spec.ts` (Worker
verify accepts/rejects the same vectors) — proving genuine Node-crypto↔
WebCrypto HMAC-SHA256 interop, not a mocked stand-in for either side.

### Backend: `GET /videos/:id/playback` extension

Same route, same `JwtAuthGuard` + `enforceEntitlementGate` (no parallel auth
system). A row with `processingState === 'ready'` and a non-null
`hlsMasterKey` now returns a SEPARATE response shape instead of the existing
one:

```jsonc
{ "type": "hls", "masterUrl": "<base>/t/<token>/master.m3u8",
  "renditions": [{ "quality": "360p", "width": 360, "height": 640, "url": "<base>/t/<token>/360p/index.m3u8" }, "..."],
  "expiresAt": "2026-08-10T21:00:00.000Z" }
```

Only the renditions actually persisted in `Video.hlsRenditions` are ever
listed (never a speculative full ladder). Every OTHER row's response stays
byte-identical to before this slice — the existing `VideoPlaybackResponseDto`
shape is untouched, and the HLS branch is checked (and falls through safely
to it on ANY mismatch, including a malformed `hlsMasterKey`) before the
existing R2/local resolution runs. If a row cleanly qualifies but
`HLS_GATEWAY_BASE_URL`/`HLS_TOKEN_SECRET` are unset, the request fails CLOSED
with `HLS_GATEWAY_NOT_CONFIGURED` (500) rather than minting against an empty
secret — unreachable in the real shipped default, since `TRANSCODE_ENABLED`
being `false` means no row can ever reach `processingState: 'ready'` with a
real `hlsMasterKey` in the first place.

### Config

`HLS_GATEWAY_BASE_URL`/`HLS_TOKEN_SECRET` follow the 11G-3 conditional
pattern: read unconditionally by `configuration.ts`, but required by
`env.validation.ts` ONLY when `TRANSCODE_ENABLED=true` (this repo's only
shipped state is `false`, so neither is set in this machine's local `.env` —
see `.env.example`'s placeholders). `HLS_TOKEN_SECRET` must also be DISTINCT
from `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`/`AUTH_AUDIT_IP_HASH_SECRET` —
boot fails loudly (naming which variable collided, never a value) if it
matches any of them. `HLS_TOKEN_TTL_SECONDS` is optional even when enabled
(default 3600s).

### Worker (`workers/hls-gateway/`)

Route `GET /t/<token>/<relativePath>`. Fixed request order (binding):
verify token → normalize + validate the relative path
(`src/path.ts#normalizeRelativePath` — percent-decode once, reject
traversal/backslash/control-chars/leading-slash/residual `%2e`/`%2f`/`%5c`,
NFC-normalize and re-check, allowlist `[A-Za-z0-9._-]` per segment) → build
the object key from the TOKEN's own prefix + the normalized path
(`src/path.ts#buildObjectKey`, plain string concatenation — never
`path.join`, which collapses `..` instead of rejecting it) → **only now** may
the cache be consulted → read from R2 (`env.MEDIA_BUCKET.get`, honoring
`Range` requests, 206 + `Content-Range` when ranged). ANY failure before the
R2 read (malformed route, invalid/expired token, traversal, prefix escape)
returns a uniform, detail-free 403; a missing object after successful auth
returns a generic 404 — neither ever echoes the token, secret, or requested
key. Content-Type resolved by extension only
(`.m3u8`→`application/vnd.apple.mpegurl`, `.mp4`→`video/mp4`,
`.m4s`→`video/iso.segment`, `.jpg`→`image/jpeg`, else
`application/octet-stream`). No CORS by default (native HLS players don't
need it) — a commented design note in `src/index.ts` covers a future,
narrow-origin-only web-playback allow-list, not implemented here.

**Cache (§9a amendment) — ships DISABLED.** `CACHE_ENABLED` must be the
EXACT string `"true"` to activate anything; every real deployment example
(`wrangler.toml.example`) ships `"false"`. When enabled, the cache key is the
CANONICAL object key (mediaId + immutable generation prefix + relative path)
— never the tokenized URL — and is only ever consulted AFTER authorization
already succeeded (`src/cache.ts`'s doc comment has the full ordering proof).
Purge/invalidation is never explicit: a re-transcode produces an entirely new
canonical key (immutable versioned prefixes), so a stale entry for a
superseded generation simply becomes unreachable, never "stale but still
served" — and the backend's existing `TRANSCODE_CLEANUP_GRACE_MINUTES`
(120 min) being longer than the max token TTL (30-60 min) means a cached
generation's R2 objects are never janitor-deleted while a live token for them
could still exist.

Self-contained npm package (own `package.json`: `vitest` +
`@cloudflare/workers-types` + `typescript` only) — `npm test` (vitest, no
miniflare, fake `Env`/`MediaBucket`/`CacheLike`) and `npm run typecheck`
(`tsc --noEmit`) both run independently of this repo's own `npm test`/
`npm run build`.

### Real deployment (explicitly out of scope for this slice)

No Cloudflare account/bucket/Worker was created or touched. Deploying
requires a separate, explicitly-permitted step (per the 2026-08-10 approval:
"NOT deployed in this slice unless separately permitted — if deployment
needs a new human action, STOP and ask").

## Testing

```bash
npm run test       # unit tests (fs is mocked — no real video files needed)
npm run test:e2e   # e2e tests (boots the real app against your local .env,
                    # including a live Range request against a real company MP4)
npm run test:cov   # coverage
```

### Manual testing

```bash
curl http://localhost:3000/health

curl http://localhost:3000/config/ads

curl http://localhost:3000/videos/feed

curl http://localhost:3000/videos/video-001

curl -I http://localhost:3000/videos/video-001/stream

curl -i \
  -H "Range: bytes=0-1023" \
  http://localhost:3000/videos/video-001/stream
```

The last command should return `HTTP/1.1 206 Partial Content` with
`Content-Range: bytes 0-1023/<file size>` and `Accept-Ranges: bytes`.

You can also open a `playbackUrl` from `GET /videos/feed` directly in a
browser to confirm the real company video plays and that seeking (which
relies on Range requests) works.

## Database (Phase 8 / Phase 8P)

The backend uses Prisma with **PostgreSQL** as its only database provider
(`prisma/schema.prisma`'s `datasource db` is `provider = "postgresql"`).
The database was originally added in Phase 8 as SQLite and fully migrated to
PostgreSQL in Phase 8P (work units 8P-0..8P-6) — SQLite is no longer used
anywhere in this project. Five models:

- `User` — registered accounts (`email`, bcrypt `passwordHash`, optional
  `displayName`).
- `Session` — refresh-token state (`refreshTokenHash`, `expiresAt`,
  `revokedAt`) backing `/auth/refresh` and `/auth/logout` rotation/revocation.
  Phase 12, work unit 12B-B2 added three additive, nullable columns —
  `userAgent`, `ipHash` (HMAC, never the raw IP), `lastUsedAt` — surfaced
  (never a hash) by `GET /auth/sessions`; see the "Session metadata" section
  above.
- `Video` — the video catalog previously hardcoded in `videos.data.ts`, now
  seeded into this table (`prisma/seed.ts`) and read by `VideosService` at
  request time. `sortOrder` is derived from each record's array position in
  `prisma/seed.ts`'s `VIDEOS` array (fixed in work unit 8P-4 — the original
  seed script never set it for pre-existing rows).
- `UserVideoInteraction` (Phase 9) — per-`(userId, videoId)` `isLiked`/
  `isSaved` state, backing the Like/Save endpoints. `videoId` is a plain
  string, not a `@relation` FK to `Video.id` — existence is checked explicitly
  at the service layer instead (see "Interactions & Progress API" above).
- `WatchProgress` (Phase 9) — per-`(userId, seriesId)` watch position
  (`lastWatchedVideoId`, `lastWatchedEpisodeNumber`, `positionSeconds`,
  `durationSeconds`), backing the watch-progress endpoints. Like
  `UserVideoInteraction`, `seriesId`/`lastWatchedVideoId` are plain strings
  with no DB-level FK — there is no separate `Series` entity in this schema.

Any database or schema decision for this project is recorded in the control
workspace's `DECISIONS.md` (outside this repo), not silently chosen.

### Setting up PostgreSQL locally

Two supported paths — pick whichever fits your machine:

**Option A: Docker Compose (recommended if you have Docker).** A portable
`docker-compose.yml` is provided at the repo root:

```bash
docker compose up -d           # starts a postgres:16-alpine container
docker compose ps              # confirm the healthcheck (pg_isready) is "healthy"
```

It reads `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `POSTGRES_PORT`
from your `.env` (see `.env.example`), exposes Postgres only on
`127.0.0.1:${POSTGRES_PORT:-5433}`, and persists data in a named volume
(`short_drama_pgdata`) so a container restart doesn't lose local data. You
still need a second, separate database for e2e tests (`short_drama_test`) —
create it inside the same container, e.g.:

```bash
docker compose exec postgres createdb -U "$POSTGRES_USER" short_drama_test
```

**Option B: native local PostgreSQL install** (what was actually used to
develop and validate Phase 8P in this environment — e.g. via Homebrew:
`brew install postgresql@16 && brew services start postgresql@16`). Create
the two databases directly:

```bash
createdb short_drama_dev
createdb short_drama_test
```

Either way, point `DATABASE_URL` at the dev database and `DATABASE_URL_TEST`
at the test database in your `.env` (see `.env.example` for the exact
connection-string format).

### Command reference

**Dev setup / schema changes:**

```bash
npx prisma generate              # regenerate the Prisma client after any schema change
npx prisma migrate dev           # apply pending migrations to DATABASE_URL (creates the db/schema if missing)
npx prisma db seed               # seed/refresh the 40-video catalog (idempotent — safe to re-run)
```

**Future schema changes** (new models/fields): edit `prisma/schema.prisma`,
then run:

```bash
npx prisma migrate dev --name <short-description-of-the-change>
```

This both applies the new migration locally and writes a new
`prisma/migrations/<timestamp>_<name>/` folder to commit.

**Test database:** `npm run test:e2e` automatically targets `DATABASE_URL_TEST`
instead of `DATABASE_URL` — `test/jest-e2e.setup.ts` runs as a Jest
`setupFiles` entry before any test file (or `@prisma/client`) loads, and
throws a clear startup error if `DATABASE_URL_TEST` is unset. No manual step
is required beyond having `DATABASE_URL_TEST` set once and having run
`npx prisma migrate dev` and `npx prisma db seed` against that database at
least once (same commands as above, just with `DATABASE_URL_TEST` as the
active `DATABASE_URL` — e.g. `DATABASE_URL="$DATABASE_URL_TEST" npx prisma
migrate dev` / `... npx prisma db seed`).

**Backups:**

- *Historical (SQLite era):* `prisma/backups/` holds a one-time snapshot
  (`dev.db.pre-postgres-migration-2026-07-23.bak`) taken immediately before
  the Phase 8P SQLite→PostgreSQL migration, kept only as a rollback reference.
  It is not read by any code and nothing regenerates it automatically.
- *PostgreSQL, going forward:* there is no automated backup/restore tooling
  yet (see "Known gaps" below). The manual equivalent, if ever needed, is:

  ```bash
  pg_dump "$DATABASE_URL" -F c -f backup.dump      # backup
  pg_restore -d "$DATABASE_URL" backup.dump        # restore
  ```

**Reset — READ THIS BEFORE RUNNING:**

```bash
npx prisma migrate reset
```

This **drops and recreates the entire target database**, then reapplies all
migrations and reruns the seed script. `prisma` reads whichever `DATABASE_URL`
is currently active in your environment/`.env` — **never run this command
without first confirming exactly which `DATABASE_URL` is active** (dev? test?
something else?). Running it against the wrong connection string is
irreversible data loss. This is a standing safety rule, not specific to any
one work unit.

### Known gaps

- ~~No rate limiting on `/auth/login` or `/auth/register`~~ — **resolved**
  (see "Known gaps in the Auth API" above for the full detail and remaining
  scoped-out item: IP throttling is in-memory per instance until Phase 13).
- **`JwtAuthGuard` does not re-check user existence per request** — see
  "Known gaps in the Auth API" above.
- ~~`sortOrder` not set for future/newly-seeded videos~~ — **resolved** in
  work unit 8P-4: `prisma/seed.ts` now derives `sortOrder` from each record's
  position in the `VIDEOS` array for both new and already-seeded rows.
- **No automated PostgreSQL backup/restore tooling.** Only the manual
  `pg_dump`/`pg_restore` commands documented above exist; nothing runs them on
  a schedule or before risky operations (e.g. `migrate reset`).
- **`InteractionsService.unlike()` has a pre-existing, unfixed decrement
  race.** Its floor-at-0 `likeCount` decrement does a JS-level read-then-write
  inside its `$transaction` (unlike `like()`'s atomic increment), so truly
  concurrent unlikes on the same video from different users could
  theoretically lose an update. Confirmed low-likelihood, predates Phase 8P,
  not reproduced, and intentionally left unfixed — recorded in the control
  workspace's `DECISIONS.md` (2026-07-23, Phase 8P work unit 8P-5), not this
  repo.

## Why company videos are never committed

`STORAGE_ROOT` points at real, company-owned Mandarin drama video files
outside this repository. The backend only ever reads from that path — it
never copies, moves, renames, or writes into it. `.gitignore` excludes
`*.mp4`, `*.mov`, `*.mkv`, and common storage folder names so that real media
can never be accidentally committed. Only source code and small, hardcoded
metadata (relative `storageKey` values, titles, captions) are tracked in git.

## What's next

Phase 5B connected the mobile app (Expo/React Native) to this backend,
replacing the temporary Python HTTP server and wiring `storageKey` /
`playbackUrl` through the existing video service layer. Phase 8 added the
database and `/auth/*` module described above. Phase 9 added per-user
Like/Save and watch-progress endpoints described in "Interactions & Progress
API" above. Phase 8P migrated that database from SQLite to PostgreSQL — see
"Database" above for the full setup and command reference. Phase 10 added
account-wide premium entitlement and closed a real gap: `GET
/videos/:id/stream` previously had no guard at all (any client with a video
id could stream any file); it now requires `Authorization: Bearer
<accessToken>` and, for episode 6+, an active entitlement — see
"Entitlements API" above. Phase 11 added analytics/monitoring, the
credential-free media/thumbnail/import tooling, and the admin content-
management API described above. Phase 12 (this backend's most recent phase)
is a security, privacy, and account-lifecycle pass: rate limiting +
persistent account lockout, `helmet` + a 256kb body limit, the
`AuthAuditEvent` audit trail, change-password/logout-all/session-list/
session-revoke, password reset, account deletion, data export, and the
retention/cleanup jobs described in their respective sections above, plus an
admin-authorization review and a full backend security review (see
`reports/phase-12-*` in the control workspace). Known gaps carried forward:
`JwtAuthGuard` not re-checking user existence per request, IP-level
throttling staying in-memory per instance until Phase 13, and the other
items under "Known gaps in the Auth API" and the Database section's "Known
gaps" above.
