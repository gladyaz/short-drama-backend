# short-drama-backend

Phase 5A: a minimal NestJS backend for the mobile short-drama app. It exposes
company video metadata and securely streams local MP4 files with HTTP
Range-request support, so the mobile app can move off the temporary Python
HTTP server.

Phase 8 added a real SQLite database (via Prisma) and a JWT-based `/auth/*`
module (register/login/refresh/logout/me) — see "Auth API" and "Database"
below.

## Architecture

```
mobile app (Expo/React Native)  -->  NestJS backend  -->  local company storage (STORAGE_ROOT)
                                            |
                                            +-->  SQLite database (DATABASE_URL, via Prisma)
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
  the SQLite database (seeded from the same 40 records that previously lived
  in `src/videos/videos.data.ts`) rather than an in-memory array — see
  "What changed in Phase 8" below. Company video *files* themselves are still
  never touched by the database; only metadata rows point at `storageKey`
  values.
- As of Phase 8, the backend also has a real user database (`User`,
  `Session` tables) and JWT-based authentication (`/auth/*`). Company video
  streaming (`/videos/*`) does **not** currently require authentication —
  no work unit has wired a guard onto those routes yet.

## Environment variables

| Variable             | Purpose                                                                 |
| --------------------- | ------------------------------------------------------------------------ |
| `PORT`                | Port the server listens on (binds `0.0.0.0` so a simulator/device on the same network can reach it) |
| `PUBLIC_BASE_URL`     | Base URL used to build each video's `playbackUrl`                        |
| `STORAGE_ROOT`        | Absolute path to the company video storage folder (read-only)            |
| `CORS_ORIGINS`        | Comma-separated list of allowed origins (e.g. the Expo dev server)        |
| `DATABASE_URL`        | Prisma connection string for the SQLite dev database (e.g. `file:./dev.db`) — added in Phase 8 for the `User`/`Session`/`Video` tables |
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
Prisma-backed `Video` table in the SQLite database (`DATABASE_URL`), seeded
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

Error codes used across the video API: `VIDEO_NOT_FOUND`, `MEDIA_FILE_NOT_FOUND`,
`INVALID_MEDIA_RANGE`, `INVALID_STORAGE_PATH`. Responses never include stack
traces or absolute filesystem paths.

None of the `/videos/*` routes above require authentication.

### What changed in Phase 8 (internal only)

`/videos/feed`, `/videos/:id`, and `/videos/:id/stream` are now backed by a
real SQLite database (a Prisma `Video` model) instead of the in-memory
`videos.data.ts` array. This is purely an internal storage-layer change —
request/response shapes, status codes, and error codes for all three routes
are unchanged from Phase 5A. `VideosService` still resolves `storageKey`
against `STORAGE_ROOT`, still rejects path traversal, and still streams
bytes directly from disk; only where the metadata row comes from changed.

## Auth API (Phase 8)

Backed by the same Prisma/SQLite database as `/videos/*` (see "Database"
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

## Database (Phase 8)

The backend uses Prisma with a local SQLite file (`DATABASE_URL`) as its
database, added in Phase 8. Three models:

- `User` — registered accounts (`email`, bcrypt `passwordHash`, optional
  `displayName`).
- `Session` — refresh-token state (`refreshTokenHash`, `expiresAt`,
  `revokedAt`) backing `/auth/refresh` and `/auth/logout` rotation/revocation.
- `Video` — the video catalog previously hardcoded in `videos.data.ts`, now
  seeded into this table (`prisma/seed.ts`) and read by `VideosService` at
  request time.

Any database or schema decision for this project is recorded in the control
workspace's `DECISIONS.md` (outside this repo), not silently chosen.

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
`playbackUrl` through the existing video service layer. Phase 8 (this
backend's most recent phase) added the SQLite database and `/auth/*` module
described above. Known gaps carried forward for a future phase: no rate
limiting on `/auth/login` / `/auth/register`, and `/videos/*` routes are not
yet guarded by authentication (see "Known gaps in the Auth API").
