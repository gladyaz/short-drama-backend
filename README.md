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

Configuration is validated at startup: the app refuses to start if any
required variable is missing, or if `STORAGE_ROOT` does not exist / is not a
directory, with a clear error message.

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

Returns all registered video metadata records.

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
ENTITLEMENT_REQUIRED`.

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
