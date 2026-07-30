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

Configuration is validated at startup: the app refuses to start if any
required variable is missing, or if `STORAGE_ROOT` does not exist / is not a
directory, with a clear error message.

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
token does not exist, was already used, or has expired (never distinguished,
mirroring the `INVALID_CREDENTIALS`/`INVALID_REFRESH_TOKEN` anti-enumeration
precedent); `400` for a `newPassword` that fails the length policy.
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
1-hour window independently of use. `onDelete: Cascade` — an outstanding
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

**Nothing here runs automatically.** There is no `@Cron`, no
`OnModuleInit`/startup hook, and no HTTP route — `RetentionService` is
deliberately **not** imported by `AppModule`/`main.ts` at all, so the code is
not even loaded when the server boots, in any environment. The only way to
invoke it is the explicit CLI script below, run by hand:

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
   from either means **zero** database activity for that run.

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
