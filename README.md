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
| `CORS_ORIGINS`        | Comma-separated list of allowed origins (e.g. the Expo dev server)        |
| `DATABASE_URL`        | Prisma connection string for the PostgreSQL dev database (e.g. `postgresql://USER:PASSWORD@localhost:5433/short_drama_dev`) — added in Phase 8, migrated from SQLite to PostgreSQL in Phase 8P |
| `DATABASE_URL_TEST`   | Prisma connection string for a **dedicated** PostgreSQL test database (e.g. `.../short_drama_test`) — added in Phase 8P so `npm run test:e2e` never runs against dev data; required, or e2e tests fail loudly at startup (see "Database" below) |
| `JWT_ACCESS_SECRET`   | Secret used to sign/verify short-lived (~15 min) access tokens — added in Phase 8 |
| `JWT_REFRESH_SECRET`  | Secret used to key the HMAC-SHA256 hash of refresh tokens before they're persisted — added in Phase 8 |
| `STORAGE_DRIVER`      | Which storage backend is active: `local` (default; unset/empty also resolves to `local`) or `r2` — added in Phase 11, work unit 11G-3. See "Storage driver (`STORAGE_DRIVER`)" below. |

Configuration is validated at startup: the app refuses to start if any
required variable is missing, or if `STORAGE_ROOT` does not exist / is not a
directory, with a clear error message.

### Storage driver (`STORAGE_DRIVER`)

`STORAGE_DRIVER=local` (the default) preserves this project's existing
behavior byte-for-byte and only requires `STORAGE_ROOT` above —
`OBJECT_STORAGE_*` variables stay fully optional. `STORAGE_DRIVER=r2` is a
feature flag only: it makes the app fail fast at startup (a clear,
secret-free message naming the missing variable, never its value) if any
`OBJECT_STORAGE_*` variable is unset, plus a shape-only check that
`OBJECT_STORAGE_ENDPOINT` is a valid `http(s)` URL. Neither mode makes a
network call at startup, and setting `STORAGE_DRIVER=r2` does not yet change
what `StorageService` actually does — real request-time R2 wiring is a
separate, later, human-gated step. See `docs/r2-readiness.md` for the full
rollback and credential-insertion runbook.

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
CORS_ORIGINS=http://localhost:8081
```

For testing from a physical device on the same Wi-Fi network, set
`PUBLIC_BASE_URL` to your Mac's LAN IP instead of `localhost`
(e.g. `http://192.168.1.23:3000`).

`.env` is git-ignored and must never be committed — it contains the real,
machine-specific `STORAGE_ROOT` path. `.env.example` holds only generic
placeholder values and is safe to commit.

## Running the server

```bash
npm install
npm run start:dev   # watch mode
# or
npm run start        # single run
```

On startup you should see logs confirming the port, public base URL, and CORS
origins — and an immediate, readable error if `STORAGE_ROOT` is misconfigured.

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

### Known gaps in the Auth API

- **No rate limiting yet** on `/auth/login` or `/auth/register`. This was
  flagged during the Phase 8 security review and is tracked as a
  pre-production requirement, not yet implemented.
- **`JwtAuthGuard` does not re-check user existence per request.** It only
  verifies the access token's signature and expiry; it does not query the
  database on every guarded request (unlike refresh-token handling, which is
  fully DB-backed). In practice this means a deleted/deactivated user's
  already-issued access token keeps working until it naturally expires
  (~15 minutes), even though `GET /auth/me` itself does catch this case by
  looking the user up explicitly. This tradeoff was noted during the 8-B6
  review and accepted for this phase to keep per-request auth cheap.

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
The app refuses to boot at all if `DEV_TOOLS_ENABLED=true` while
`NODE_ENV=production` (see `src/config/env.validation.ts`) — these routes
must never be reachable in a real deployment.

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
secret-free storage-readiness signal:

```json
{ "storage": { "driver": "local", "ready": true, "configPresent": true } }
```

- `driver` — the active `STORAGE_DRIVER` (`"local"` or `"r2"`).
- `configPresent` — whether the required config variable **names** for the
  active driver are all set (`local` → `STORAGE_ROOT`; `r2` → every
  `OBJECT_STORAGE_*` name) — presence only, never a value.
- `ready` — `local`: `STORAGE_ROOT` exists and is a readable directory (a
  local `fs.stat`, never a network call). `r2`: always equal to
  `configPresent` — this endpoint deliberately never makes a live network/R2
  probe, so `ready: true` in `r2` mode means "the required config names are
  set," not "R2 was successfully contacted."

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
- `category` (string, 1–100 chars)
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
admin-only DTO, never on the public `VideoResponseDto`.

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
  `SeriesDto[]`, ordered by `sortOrder` then `id`. **Excludes archived rows
  by default** (work unit 11F-1) — pass `?includeArchived=true` (a
  validated boolean; any value other than exactly `true`/`false`,
  case-insensitive, is rejected with `400`) to include them too.
- **`GET /admin/series/:id`** — work unit 11F-1 read-detail. Returns `200`
  with the `SeriesDto` (archived or not), or `404 SERIES_NOT_FOUND` for an
  unknown id.
- **`POST /admin/series`** — body `{ "id", "title", "coverImageKey"?,
  "sortOrder"? }`. Returns `201` with the created `SeriesDto`. A
  duplicate `id` returns a clean `409 SERIES_ALREADY_EXISTS` (pre-checked,
  and also caught if a race loses to a raw Prisma unique-constraint
  violation) rather than an unstructured 500.
- **`PATCH /admin/series/:id`** — a partial edit: any subset of `title`,
  `coverImageKey`, `sortOrder` (same constraints as create). `id` itself
  is not accepted in the body (rejected by the global whitelist — it is
  immutable). At least one field must be present, or `400
  EMPTY_SERIES_UPDATE`. An unknown `id` returns `404 SERIES_NOT_FOUND`.
  Returns `200` with the updated `SeriesDto`.
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

- **No rate limiting yet** on `/auth/login` or `/auth/register` (see "Known
  gaps in the Auth API" above).
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
"Database" above for the full setup and command reference. Phase 10 (this
backend's most recent phase) added account-wide premium entitlement and
closed a real gap: `GET /videos/:id/stream` previously had no guard at all
(any client with a video id could stream any file); it now requires
`Authorization: Bearer <accessToken>` and, for episode 6+, an active
entitlement — see "Entitlements API" above. Known gaps carried forward for a
future phase: no rate limiting on `/auth/login` / `/auth/register` (see
"Known gaps in the Auth API"), and the other items under the Database
section's "Known gaps".
