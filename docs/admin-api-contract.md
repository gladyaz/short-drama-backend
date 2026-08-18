# Admin API Contract

**Frozen for Slice #4 wiring (2026-07-25); re-frozen 2026-07-30 (work unit
12E-B4).** This document is the authoritative, frozen contract for every
admin-guarded route this backend currently exposes, **plus the cross-cutting
request-level behaviors (rate limiting, request body size limit) that apply
to those routes**, added by the re-freeze below. It was originally produced
by work unit **11F-5** (the gate before any admin/mobile wiring — see the
control workspace's `DECISIONS.md`, "2026-07-25 — Phase 11 credential-free
endpoint slice: formal approval (ratify + expand) → Slice #4") and reflected
exactly what was implemented on `short-drama-backend` as of commit `1214f2c`
(11F-1..11F-4 landed).

**Re-freeze, 2026-07-30 (work unit 12E-B4, resolving `TASK_QUEUE.md`
follow-up 19 / `DECISIONS.md`'s 2026-07-30 "Phase 12 decision-resolution
remediation slice (12E) approved..." entry, decision 4):** independent
verification against the source found that Phase 12 (work units 12A-B1 and
12A-B2, landed well before this re-freeze) had added two cross-cutting
behaviors this document never mentioned — IP-based request throttling
(`429`) and a JSON request body size limit (`413`) — both of which apply to
every route below. **Nothing about route behavior changed to produce this
re-freeze**; the routes, fields, shapes, and existing status/error codes
documented below are unchanged from the 2026-07-25 freeze. Only the two new
sections ("Rate limiting" and "Request body size limit") and the
correspondingly updated error-codes table are new. This document reflects
exactly what is implemented on `short-drama-backend` as of commit `7d58b8b`
(everything through Phase 12, work units 12A-B1..12E-B3, in addition to the
11F-1..11F-4 baseline above). It documents **only** routes, fields, shapes,
status codes, and error codes that actually exist in this repository today —
nothing here is aspirational.

**Consumers of this freeze:**
- **11F-6** (`short-drama-admin` repo) — wires the admin dashboard's badged
  surfaces to the real endpoints described below. Real R2 byte upload stays
  mocked; anything marked "GATED" below must stay visibly mocked/pending in
  the UI, never faked as a real success.
- **11F-7** (`mobile-app-ecc` repo, docs only) — updates
  `docs/api-contract.md` (+ admin README) for the DB-backed access-tier model
  described below, without activating payments.

Any change to a route, field, shape, status code, or error code documented
here requires a new, explicit `DECISIONS.md` entry re-freezing the contract
before 11F-6/11F-7 (or any later work) may rely on the changed behavior.

**Re-freeze, 2026-08-14 (work unit "SERIES COVER UPLOAD BACKEND CONTRACT",
approved in the control workspace's `DECISIONS.md` "2026-08-14 — SERIES
COVER UPLOAD BACKEND CONTRACT APPROVED..." entry and
`phases/phase-series-metadata.md` §"Work unit 2", baseline `a895116`,
recorded BEFORE implementation):** adds the real Series poster/cover upload
flow this document had no prior coverage for, and changes two previously
frozen behaviors:
1. **New:** `POST /admin/series/:id/cover` (presign-init) and
   `POST /admin/series/:id/cover/complete` (verify + persist) — see the
   "Admin series" section below.
2. **Changed:** `PATCH /admin/series/:id`'s `coverImageKey` now explicitly
   accepts `null` (clears the cover) as a documented, distinct third state
   alongside "omitted" (unchanged) and "a string" (set/replace) — previously
   undocumented (an accidental side effect of `class-validator`'s
   `@IsOptional()`, never a stated contract).
3. **Changed:** `GET /admin/series` and `GET /admin/series/:id` now return
   `SeriesWithCoverDto` (adds a signed `coverUrl` field) instead of the plain
   `SeriesDto` — additive, all previously-documented fields are unchanged.
   `POST /admin/series`, `PATCH /admin/series/:id`, and the archive/unarchive
   routes are UNCHANGED — they still return the plain `SeriesDto`.

Nothing about `POST /admin/media`, `GET/PATCH /admin/media/:id`,
`POST /admin/media/:id/complete-upload`, `publish`/`unpublish`, or the
pre-existing `POST /admin/media/:id/cover`/`:id/thumbnail` routes changed —
those stay exactly as documented below (the new series-cover routes are a
separate, additive surface, deliberately not built on top of the pre-existing
`CreateMediaAssetUploadDto`/`createAssetUpload` pattern — see this section's
own note on why).

**Re-freeze, 2026-08-15 (fix cycle 1, closing a reviewer-reproduced HIGH
finding against the 2026-08-14 cover-upload contract above):** a reviewer
proved that, because nothing was persisted at presign time, `POST
/admin/series/:id/cover/complete` accepted ANY previously-minted, well-formed
key for a series forever — including one from a generation already replaced
by a later upload, or one whose cover had since been explicitly cleared via
`PATCH { coverImageKey: null }`. A stale/replayed `complete` call could
therefore silently revert a legitimate replace, or silently un-clear an
explicit clear. This is now closed with an additive, nullable
`Series.pendingCoverImageKey` column (mirroring the 11P
`TranscodeIntentService` durable-intent precedent):
1. `POST /admin/series/:id/cover` now ALSO writes the freshly minted key into
   `pendingCoverImageKey` (latest mint always wins — a new presign
   invalidates any earlier one). Still does **not** touch the public
   `coverImageKey`/`coverUrl`.
2. `POST /admin/series/:id/cover/complete` now accepts `key` only when it
   equals the row's CURRENT `pendingCoverImageKey` (normal path) or its
   CURRENT `coverImageKey` (idempotent re-complete, unchanged). Any other
   well-formed key is rejected with a new `409 SERIES_COVER_KEY_SUPERSEDED`
   — never silently re-applied.
3. `PATCH /admin/series/:id { coverImageKey: null }` now ALSO clears
   `pendingCoverImageKey` in the same write — an explicit clear invalidates
   any upload that was still in flight.

See the "Admin series" section's `POST /admin/series/:id/cover/complete`
entry and the error-codes table below for the full updated behavior. Every
other 2026-08-14 behavior (replace semantics, idempotency on the
already-live key, the four independent verification checks) is unchanged.

**Re-freeze, 2026-08-15 (work unit "Episode Access-Tier + Category Contract
Hardening", approved in the control workspace's `DECISIONS.md` "2026-08-15
— EPISODE ACCESS-TIER + CATEGORY CONTRACT HARDENING APPROVED..." entry,
baseline `3190d93`):** two additive changes to this admin surface, both
already authorized by that approval ("the current approval covers additive
DTO exposure" — no separate re-freeze approval round-trip was required):

1. **New field:** `AdminMediaDto.accessTier` (`"free"` \| `"premium"`) — the
   resolved/effective tier, additive alongside the pre-existing raw
   `accessTierOverride`. Returned by every route that already returns
   `AdminMediaDto` (`POST /admin/media`, `GET /admin/media`,
   `PATCH /admin/media/:id`, `PATCH /admin/media/:id/access-tier`, and the
   asset-upload routes). See the "`AdminMediaDto`" and "Access-tier model"
   sections below.
2. **Narrowed validation, NOT a shape change:** `category` on
   `POST /admin/media` and `PATCH /admin/media/:id` is no longer freeform
   (`@IsString() @Length(1, 100)`) — it is now a closed set of four
   canonical values (`action`\|`comedy`\|`drama`\|`romance`,
   `VIDEO_CATEGORIES` in `src/videos/video-category.constants.ts`). Every
   value this contract's own examples and every value this backend has ever
   actually persisted already used this exact set, so no previously-valid
   real request becomes invalid; only a genuinely unrecognised string (which
   would previously have been silently accepted) now returns a clean `400`.

Nothing else in this document changed. `GET /admin/media`'s `category`
QUERY FILTER (`ListAdminMediaQueryDto.category`, an exact-match read filter,
not a write validator) is UNCHANGED — still freeform, since an unrecognised
filter value is harmless (it simply matches zero rows).

**Hardening, 2026-08-18 (slice "SERIES COVER UPLOAD CONCURRENCY / TOCTOU
HARDENING", baseline `2f285d1`) — NO route, shape, status code, or error
code changed; this is a concurrency guarantee, not a contract change.** The
2026-08-15 currency check above closed REPLAYED completions (a stale key
submitted after the state had already moved on), but not CONCURRENT ones: it
compares `key` against a row read BEFORE the storage `HEAD` round-trip, while
the final write was unconditional. A completion could therefore pass the
currency check, be superseded DURING its verification (by a
`PATCH { coverImageKey: null }` removal, or by a newer
`POST /admin/series/:id/cover` intent), and still win the write —
resurrecting a just-removed cover or reverting a newer one. The final write
of `POST /admin/series/:id/cover/complete` is now an ATOMIC COMPARE-AND-SET
conditioned on `pendingCoverImageKey` still equalling the completing key at
the instant of the write; a completion that loses it writes nothing and is
answered with the SAME `409 SERIES_COVER_KEY_SUPERSEDED` an already-stale key
gets. No schema migration was required (the existing
`Series.pendingCoverImageKey` column became the CAS predicate). Full
semantics — newest-intent-wins, Remove invalidating outstanding intent,
duplicate/simultaneous completion behavior, and orphan-object consequences —
are documented in `POST /admin/series/:id/cover/complete`'s entry below.

## Conventions

- No global route prefix (e.g. `GET /health`, not `GET /api/health`).
- Every request/response body is JSON.
- The global `ValidationPipe` (`src/main.ts`) is configured
  `{ whitelist: true, forbidNonWhitelisted: true, transform: true }`: any
  field not declared on a DTO is stripped for a plain-optional field or
  causes a `400` for an entirely unrecognized field on a body/query that
  uses `forbidNonWhitelisted`; class-validator constraint failures (missing
  required field, wrong type, out-of-range) also produce a `400`.
- **Error envelope.** Every error response is JSON via `AppExceptionFilter`
  (`src/common/filters/app-exception.filter.ts`), one of two shapes:
  - A structured, business-logic error thrown as `AppException`:
    `{ "statusCode": <n>, "code": "<AppErrorCode>", "message": "<text>" }`
    (e.g. `404 VIDEO_NOT_FOUND`).
  - A generic Nest `HttpException` (this is what `ValidationPipe` itself
    throws for a class-validator failure, and what `forbidNonWhitelisted`
    throws for an unrecognized field):
    `{ "statusCode": <n>, "code": "HTTP_ERROR", "message": "<text or joined text[]>" }`.
    **DTO validation failures on every route below (missing/invalid field,
    extra field) carry `code: "HTTP_ERROR"`, not a route-specific
    `AppErrorCode`.** Only failures the service layer explicitly throws
    (not found, duplicate, conflict, empty-update, role/lifecycle checks)
    carry a specific `AppErrorCode`.
  - An unhandled exception falls back to `500 { "statusCode": 500, "code": "INTERNAL_ERROR", "message": "Internal server error" }` and never leaks a stack trace or filesystem path.
- No response documented below ever includes a raw filesystem path, secret,
  or credential.

## Auth (context — established elsewhere, summarized here for admin callers)

All `/admin/*` routes below require **both**:
1. A valid access token: `Authorization: Bearer <accessToken>`
   (`JwtAuthGuard`). Missing/malformed header, expired token, or
   invalid/tampered signature → `401 INVALID_ACCESS_TOKEN`.
2. The caller's `User.role` to be exactly `"admin"` (`AdminGuard`, which
   always runs AFTER `JwtAuthGuard` so it can read `request.user`, and does
   one DB lookup per request since the JWT payload itself does not carry the
   role). A missing `request.user` or a non-admin role → `403
   ADMIN_ROLE_REQUIRED`. `AdminGuard` never itself returns `401` — by the
   time it runs, `JwtAuthGuard` has already accepted or rejected the token.

How an access token is obtained/refreshed (unchanged by this slice, full
detail in the main `README.md`'s "Auth API" section):

| Route | Auth required | Returns |
|---|---|---|
| `POST /auth/login` | none (body `{email, password}`) | `200 AuthResponseDto` |
| `POST /auth/refresh` | none (body `{refreshToken}`, refresh token itself is the credential) | `200 AuthResponseDto` |
| `POST /auth/logout` | none (body `{refreshToken}`) | `200 { "success": true }` |
| `GET /auth/me` | `Bearer <accessToken>` | `200 AuthUserDto` |

`AuthResponseDto`: `{ user: { id, email, displayName? }, accessToken, refreshToken }`.
`AuthUserDto`: `{ id, email, displayName? }`.

### `GET /admin/whoami`

The minimal, concrete proof that `AdminGuard` protects a route end-to-end
(work unit 11B-2) — not itself part of the content-management surface, but
the smallest example of the auth pattern every route below uses.

- Guards: `JwtAuthGuard`, `AdminGuard`.
- Returns `200 AdminRoleStatusDto`: `{ "userId": "...", "role": "admin" }`.

## Admin media (`src/media/admin-media.controller.ts`, `@Controller('admin/media')`)

Every route below is `@UseGuards(JwtAuthGuard, AdminGuard)` at the controller
level. `AdminMediaService`'s `StorageService` dependency is **mocked in
every test**; no route here ever makes a real R2/S3 network call in this
credential-free slice (see "Explicitly still GATED" below).

### `POST /admin/media`

Creates a new media record in `draft` state alongside a presigned upload
URL. Body (`CreateMediaUploadDto`):

| Field | Type | Constraint |
|---|---|---|
| `seriesId` | string | 1–200 chars, required |
| `title` | string | 1–200 chars, required |
| `episodeNumber` | integer | `>= 1`, required |
| `channelName` | string | 1–200 chars, required |
| `caption` | string | 1–2000 chars, required |
| `category` | string | one of the four canonical values (`action`\|`comedy`\|`drama`\|`romance`, `VIDEO_CATEGORIES`), required — narrowed from freeform 1–100 chars by work unit "Episode Access-Tier + Category Contract Hardening"; an unrecognised value → `400` |
| `sourceLanguage` | string | 1–20 chars, required |
| `hasEmbeddedIndonesianSubtitle` | boolean | required |
| `durationSeconds` | integer | `>= 0`, optional |
| `width` | integer | `>= 1`, optional |
| `height` | integer | `>= 1`, optional |
| `contentType` | string | 1–100 chars, optional — passed through to the presigned PUT URL's `Content-Type` |

Behavior:
- Rejects a duplicate `(seriesId, episodeNumber)` pair (an existing `Video`
  row already has that exact combination) with `409
  DUPLICATE_EPISODE_NUMBER` — checked before anything is created (work unit
  11F-3).
- Sets a **create-time derived access tier**: `accessTierOverride` is set
  from `episodeNumber` via `deriveAccessTier` (`episodeNumber >
  FREE_EPISODE_LIMIT` → `"premium"`, else `"free"`) — work unit 11F-4. Every
  newly created row starts with a non-null tier; it can be changed
  afterward via `PATCH /admin/media/:id/access-tier` below.
- `id` is server-generated (`media-<uuid>`); `storageKey` (the legacy local
  `STORAGE_ROOT`-relative field) is set to `""`, never a real path —
  admin-created rows are not reachable via the public feed until published,
  and object-storage playback wiring is out of scope for this slice (11A-3).
- Calls `StorageService.createPresignedPutUrl` — **mocked** in every test
  (see "Explicitly still GATED" below).

Returns `201 CreateMediaUploadResponseDto`:
```json
{ "media": { /* AdminMediaDto */ }, "upload": { "url": "...", "key": "...", "expiresAt": "2026-07-25T12:00:00.000Z" } }
```

### `GET /admin/media`

The admin inventory list (work unit 11E-1, extended with filters in
11F-2) — unlike the public `GET /videos/feed`, returns rows across **all
five** lifecycle states. Query params (`ListAdminMediaQueryDto`), all
optional:

| Param | Type | Notes |
|---|---|---|
| `status` | one of `draft`/`ready`/`published`/`unpublished`/`failed` | exact match; invalid value → `400` |
| `seriesId` | string, 1–200 chars | exact match |
| `search` | string, 0–200 chars | case-insensitive substring match against `title` OR `caption` OR `channelName`; trimmed, and empty/whitespace-only is treated as absent |
| `tier` | `"free"` \| `"premium"` | exact match on the DB-backed `accessTierOverride` column (does NOT re-derive from `episodeNumber`) |
| `category` | string, 1–200 chars | exact match (not substring) |
| `page` | integer, `>= 1` | default `1` |
| `pageSize` | integer, `1..100` | default `20` |

All provided filters are ANDed together (`search`'s three-field match is an
`OR` nested inside that AND). Returns `200`:

```json
{ "items": [ /* AdminMediaDto[] */ ], "total": 0, "page": 1, "pageSize": 20 }
```

Ordered deterministically by `sortOrder` then `id`, matching the public-feed
ordering convention. Read-only — no schema change, no writes.

### `GET /admin/media/:id`

Returns `200 AdminMediaDto`, or `404 VIDEO_NOT_FOUND` for an unknown `id`.

### `PATCH /admin/media/:id`

A partial metadata edit (work unit 11E-2, extended with duplicate-episode
validation in 11F-3). Body (`UpdateMediaMetadataDto`) accepts any subset of
these **7 editable fields**, each with the identical constraint the create
route applies:

| Field | Type | Constraint |
|---|---|---|
| `title` | string | 1–200 chars |
| `caption` | string | 1–2000 chars |
| `category` | string | one of the four canonical values (`action`\|`comedy`\|`drama`\|`romance`) — same closed set as `POST /admin/media`'s `category`; an unrecognised value → `400` |
| `channelName` | string | 1–200 chars |
| `sourceLanguage` | string | 1–20 chars |
| `episodeNumber` | integer | `>= 1` |
| `hasEmbeddedIndonesianSubtitle` | boolean | — |

- At least one field must be present — an empty body →
  `400 EMPTY_MEDIA_METADATA_UPDATE`.
- Every other `Video` column (`id`, `seriesId`, `lifecycleState`, the
  object-storage/cover/thumbnail keys, `storageKey`, `sortOrder`,
  `likeCount`, `durationSeconds`/`width`/`height`, `accessTierOverride`) is
  **immutable via this route** — the global `forbidNonWhitelisted` rejects a
  body containing any of them (or any other unrecognized field) with a
  `400 HTTP_ERROR` before the service is even called; the service applies a
  second, independent whitelist as defense-in-depth.
- If the body includes `episodeNumber` and it differs from the row's
  current value, a collision with ANOTHER row in the same `seriesId`
  (`seriesId` itself is not editable here, so it is always the row's
  existing series) → `409 DUPLICATE_EPISODE_NUMBER` (work unit 11F-3).
  Setting `episodeNumber` to the row's own current value is a no-op, not a
  collision.
- Unknown `id` → `404 VIDEO_NOT_FOUND`.

Returns `200 AdminMediaDto` (updated).

### `PATCH /admin/media/:id/access-tier`

Sets or clears the per-episode access-tier override (work unit 11E-3, made
the DB-backed enforcement source of truth by 11F-4). Body
(`UpdateAccessTierDto`):

```json
{ "tier": "free" }
```

- `tier` is **required** (unlike the metadata PATCH's fields) and must be
  exactly one of `"free"`, `"premium"`, or `null` — any other value, or an
  entirely missing `tier`, → `400 HTTP_ERROR`.
- `"premium"` — this episode always requires an active entitlement,
  regardless of `episodeNumber`.
- `"free"` — this episode always streams without an entitlement, regardless
  of `episodeNumber`.
- `null` — clears the override; the row falls back to the
  `episodeNumber > FREE_EPISODE_LIMIT` derivation the next time it is read
  (`EntitlementsService.resolveEpisodePremium`'s null-safety fallback).
- Writes **only** `accessTierOverride` — every other column is untouched.
- Unknown `id` → `404 VIDEO_NOT_FOUND`.

Returns `200 AdminMediaDto` (updated). `accessTierOverride` is exposed only
on this admin DTO, never on the public `VideoResponseDto`.

### `POST /admin/media/:id/complete-upload`

Transitions `draft` → `ready` after confirming the presigned upload actually
landed. Body (`CompleteMediaUploadDto`, all optional): `durationSeconds`
(int `>= 0`), `width` (int `>= 1`), `height` (int `>= 1`) — refined metadata
values, none required.

- `400 MEDIA_FILE_NOT_FOUND` if no upload was ever started for this record
  (`objectStorageKey` is null), or if `StorageService.objectExists` (mocked
  in tests) reports no object at that key.
- `400 INVALID_MEDIA_LIFECYCLE_TRANSITION` if the row is not currently in a
  state that can transition to `ready` (only `draft → ready` is a valid
  edge — see the lifecycle table below).
- `404 VIDEO_NOT_FOUND` for an unknown `id`.

Returns `200 AdminMediaDto` (`@HttpCode(200)` — overrides Nest's default
`201` for `@Post`).

### `POST /admin/media/:id/publish` / `POST /admin/media/:id/unpublish`

Lifecycle transitions via `MediaLifecycleService.assertTransition`, both
`@HttpCode(200)`. The full allowed-edge table
(`MEDIA_LIFECYCLE_TRANSITIONS`, `src/media/media-lifecycle.constants.ts`):

| From | Allowed `to` |
|---|---|
| `draft` | `ready`, `failed` |
| `ready` | `published`, `failed` |
| `published` | `unpublished`, `failed` |
| `unpublished` | `published`, `failed` |
| `failed` | *(terminal — no outgoing edges)* |

- `publish` → `published`: valid only from `ready` or `unpublished`.
- `unpublish` → `unpublished`: valid only from `published`.
- Any other source state → `400 INVALID_MEDIA_LIFECYCLE_TRANSITION`.
- Unknown `id` → `404 VIDEO_NOT_FOUND`.

Both return `200 AdminMediaDto` (updated).

### `POST /admin/media/:id/cover` / `POST /admin/media/:id/thumbnail`

Issues a presigned PUT URL for the cover/thumbnail image and records the
resulting object key on the `Video` row (`coverImageKey` /
`thumbnailImageKey` respectively). Body (`CreateMediaAssetUploadDto`):
`contentType` (string, 1–100 chars, optional). Unknown `id` → `404
VIDEO_NOT_FOUND`. Both default to Nest's `201` (no `@HttpCode` override).
Returns `MediaAssetUploadResponseDto` (identical shape to
`CreateMediaUploadResponseDto`):

```json
{ "media": { /* AdminMediaDto */ }, "upload": { "url": "...", "key": "...", "expiresAt": "..." } }
```

## `AdminMediaDto` (`src/media/media.types.ts`)

The admin-facing view of a `Video` row — unlike the public
`VideoResponseDto`, this never computes a `playbackUrl` (a draft/ready row
has no guaranteed streamable file) and it exposes fields the public feed
never does (`lifecycleState`, object-storage keys, `accessTierOverride`).

| Field | Type |
|---|---|
| `id` | string |
| `seriesId` | string |
| `title` | string |
| `episodeNumber` | number |
| `channelName` | string |
| `caption` | string |
| `category` | string |
| `sourceLanguage` | string |
| `hasEmbeddedIndonesianSubtitle` | boolean |
| `lifecycleState` | string (`draft`\|`ready`\|`published`\|`unpublished`\|`failed`) |
| `objectStorageKey` | string \| null |
| `objectStorageVariant` | string \| null |
| `coverImageKey` | string \| null |
| `thumbnailImageKey` | string \| null |
| `durationSeconds` | number \| null |
| `width` | number \| null |
| `height` | number \| null |
| `accessTierOverride` | `"free"` \| `"premium"` \| null |
| `accessTier` | `"free"` \| `"premium"` | ADDITIVE (work unit "Episode Access-Tier + Category Contract Hardening") — the resolved/effective tier, computed via the same `resolveAccessTier` function the public `VideoResponseDto.accessTier` field uses; always in agreement with it for the same episode |

Note: `sortOrder`, `storageKey`, and `likeCount` are `Video` columns that
exist in the database but are **not** part of `AdminMediaDto` and are not
writable via any route in this section.

## Admin series (`src/series/series.controller.ts`, `@Controller('admin/series')`)

Every route below is `@UseGuards(JwtAuthGuard, AdminGuard)` at the
controller level. A lightweight, **additive** `Series` metadata model (work
unit 11E-4, extended in 11F-1) — a separate Prisma table, not an extension
of `Video`. There is no database-level foreign key from `Video` to
`Series`; creating, editing, archiving, or deleting a `Series` row never
touches, updates, or reorders any `Video` row (except the read-only count
`DELETE` performs — see below). The public `GET /videos/feed` grouping and
`VideoResponseDto` shape are completely unaffected by this section.

### `GET /admin/series`

Query param `includeArchived` (`ListAdminSeriesQueryDto`, optional): a
strict `"true"`/`"false"` string (case-insensitive) coerced to boolean; any
other value → `400`. **Excludes archived rows by default** — pass
`?includeArchived=true` to include them too. Returns `200
SeriesWithCoverDto[]` (2026-08-14 re-freeze: `SeriesDto` plus a signed
`coverUrl`, see `SeriesWithCoverDto` below), ordered by `sortOrder` then
`id`. No pagination on this route.

### `GET /admin/series/:id`

Returns `200 SeriesWithCoverDto` (archived or not — only the default `list`
view hides archived rows; an episode-less series returns normally too, this
route never reads `Video`), or `404 SERIES_NOT_FOUND` for an unknown `id`.

### `POST /admin/series`

Body (`CreateSeriesDto`):

| Field | Type | Constraint |
|---|---|---|
| `id` | string | 1–200 chars, required, client-provided |
| `title` | string | 1–200 chars, required |
| `coverImageKey` | string | 1–500 chars, optional |
| `sortOrder` | integer | `>= 0`, optional, defaults to `0` |

A duplicate `id` (pre-checked, and also caught if a race loses to a raw
Postgres unique-constraint violation) → `409 SERIES_ALREADY_EXISTS`. Returns
`201 SeriesDto` (the plain shape — NOT `SeriesWithCoverDto`; unchanged by the
2026-08-14 re-freeze).

### `PATCH /admin/series/:id`

Body (`UpdateSeriesDto`): any subset of `title` (1–200 chars),
`coverImageKey`, `sortOrder` (int `>= 0`). `id` itself is not accepted in the
body (immutable; rejected by the global whitelist). At least one field must
be present, or `400 EMPTY_SERIES_UPDATE`. Unknown `id` → `404
SERIES_NOT_FOUND`. Returns `200 SeriesDto` (updated; the plain shape, not
`SeriesWithCoverDto`).

**`coverImageKey`'s three explicit states (2026-08-14 re-freeze — previously
undocumented):**
- **Omitted from the body:** unchanged.
- **`null`:** explicitly clears the cover (`Series.coverImageKey` is set to
  `NULL`). This is the only route that can clear a cover — there is no
  dedicated `DELETE .../cover` route.
- **A non-empty string, 1–500 chars:** sets/replaces the raw object key —
  unchanged behavior from before the re-freeze. In normal operation this is
  set via the verified `POST /admin/series/:id/cover` +
  `.../cover/complete` flow below, not by writing an unverified key directly
  through this route.

### `POST /admin/series/:id/cover` (NEW, 2026-08-14 re-freeze)

Presign-init for a cover-image upload. Body (`CreateSeriesCoverUploadDto`,
both fields REQUIRED):

| Field | Type | Constraint |
|---|---|---|
| `contentType` | string | one of `image/jpeg`, `image/png`, `image/webp` (closed allow-list — no SVG/video/`application/*`) |
| `sizeBytes` | integer | `1`–`10485760` (10 MiB, `MAX_SERIES_COVER_UPLOAD_BYTES`) |

Unknown `id` → `404 SERIES_NOT_FOUND` (checked before any presign). The
object key is entirely SERVER-generated —
`admin-series/<url-encoded seriesId>/cover/<uuid>` — the client never
supplies or chooses a key; a raw `key` field in the request body is rejected
by the global whitelist (`400`). Returns `201`:

```json
{ "upload": { "url": "...", "key": "...", "expiresAt": "..." } }
```

Does **not** persist `Series.coverImageKey` or return a `series`/`media`
field — nothing is confirmed uploaded yet. Rate-limited to the same 60
requests/minute as `POST /admin/media` (`ADMIN_MEDIA_UPLOAD_INITIATE_RATE_LIMIT`,
see "Rate limiting" below) — each call mints a real, credential-backed
presigned R2 `PUT` URL.

**Fix cycle 1 (2026-08-15): DOES write `Series.pendingCoverImageKey` = the
freshly minted key** (overwriting any prior pending value — the latest mint
always wins). This is a private, internal upload-INTENT record, never
exposed on `SeriesDto`/`SeriesWithCoverDto` and never itself treated as "the
cover" — the "does not persist `coverImageKey`" guarantee above is
completely unaffected; `pendingCoverImageKey` is a separate column that only
`POST .../cover/complete` reads, to verify a caller's `key` against a
durable server record instead of trusting the key's shape alone. See that
route's entry below.

### `POST /admin/series/:id/cover/complete` (NEW, 2026-08-14 re-freeze;
**currency check ADDED 2026-08-15, fix cycle 1**)

Verifies the upload and, only on success, persists
`Series.coverImageKey`. Body (`CompleteSeriesCoverUploadDto`):
`{ "key": "..." }` — the exact `key` the preceding presign-init response
returned. Checks, in order, BEFORE any database write:

1. The series exists (`404 SERIES_NOT_FOUND` otherwise).
2. `key` has the exact `admin-series/<this series' id>/cover/<uuid>` shape
   THIS series' own presign step would have minted — a key belonging to a
   different series, an `admin-media/...` object, or any malformed string
   → `400 SERIES_COVER_KEY_INVALID` (checked before any storage call).
3. **(fix cycle 1 — currency check)** `key` must equal EITHER the series'
   current `pendingCoverImageKey` (the normal path — proceeds to checks 4–5
   below) OR its current `coverImageKey` (an idempotent re-complete of the
   already-live cover — an immediate `200` no-op, no re-verification, no
   re-write, identical to the pre-2026-08-15 idempotent behavior). Any OTHER
   well-formed key — real shape, but neither the current upload intent nor
   the current live cover — is a superseded/stale/replayed key from an
   earlier generation → `409 SERIES_COVER_KEY_SUPERSEDED`. **This is what
   makes a stale/replayed `complete` call harmless instead of a silent
   revert or un-clear** — see the 2026-08-15 re-freeze note above for the
   two reproduced attack scenarios this closes.
4. The object actually exists at that key (`StorageService.headObject`) →
   `400 MEDIA_FILE_NOT_FOUND` if not.
5. The object's REAL, R2-reported `Content-Type` is one of the allowed MIME
   types → `409 SERIES_COVER_CONTENT_TYPE_NOT_ALLOWED` if not.
6. The object's REAL, R2-reported size is within `1`–`10485760` bytes →
   `409 SERIES_COVER_SIZE_OUT_OF_BOUND` if not.

**Content-Type/Content-Length are checked at complete-time against R2's own
reported HEAD metadata (checks 5–6), never the client's presign-time
declaration or the raw request bytes** — the presigned `PUT` itself does
**not** cryptographically bind what gets uploaded to the `contentType`/
`sizeBytes` originally declared at presign-init; a client could `PUT` bytes
of a different real type/size than it declared, and R2 will happily store
them. `headObject`'s response is the authoritative, independently-verified
source of truth this route checks against — but it is still a `Content-Type`
*label* R2 reports (whatever the uploader's `PUT` set it to), **not**
magic-byte/content-sniffing of the actual image bytes. A caller could
therefore upload non-image bytes labeled with an allowed image
`Content-Type` and pass checks 5–6. This is a known, documented gap, not a
claim of full content validation — real magic-byte sniffing is explicitly
**future hardening**, not implemented by this contract.

Only once every check passes does this write `Series.coverImageKey = key`
and, in the SAME write, clear `Series.pendingCoverImageKey` back to `null`
(fix cycle 1) — then return `200 SeriesWithCoverDto` (including a freshly
signed `coverUrl`). **Idempotent**: calling this again with the same,
already-persisted `key` (i.e. `key === coverImageKey`) is a no-op success —
unchanged from before the 2026-08-15 fix, though now implemented as an
explicit short-circuit (check 3) rather than a harmless re-verification.

**Concurrency (2026-08-18 hardening) — the final write is CONDITIONAL.**
Checks 1–3 run against a row read BEFORE check 4's storage `HEAD`
round-trip, so on their own they can only prove the key was current at READ
time. The write itself therefore carries the condition: it updates the row
only `WHERE pendingCoverImageKey = key`, i.e. only if this completion still
owns the series' current upload intent at the exact instant of the write.
The resulting rules:

- **Newest intent wins.** A `POST /admin/series/:id/cover` that lands while
  an older completion is verifying replaces the pending intent, and the
  older completion then loses. The newer pending intent is left completely
  intact by the loser and can still be completed normally afterwards.
- **Remove invalidates outstanding upload intent.**
  `PATCH /admin/series/:id { coverImageKey: null }` clears
  `coverImageKey` and `pendingCoverImageKey` in ONE statement, so there is
  no window in which the cover is removed but an in-flight completion still
  holds a matching intent. A completion that was already verifying when the
  removal landed loses the compare-and-set and **cannot resurrect the
  removed poster** — the series stays coverless until a new
  presign + completion.
- **A losing completion writes NOTHING.** It never changes
  `coverImageKey` (an existing cover stays authoritative) and never clears
  another request's `pendingCoverImageKey`.
- **Superseded response.** Losing the compare-and-set returns the SAME
  `409 SERIES_COVER_KEY_SUPERSEDED` as a key already known stale before the
  storage call. There is deliberately no second error code for this state.
- **Duplicate completion.** Sequential duplicates are unchanged (`200`
  no-op via check 3). Two SIMULTANEOUS completions of the same key both
  verify, exactly one wins the compare-and-set, and the loser — seeing that
  the live cover is now exactly the key it was completing — returns the
  same `200` no-op success rather than a conflict. Interleaving never
  changes the answer to "I completed key X and key X is the live cover";
  only one of the two actually wrote.
- **Series deleted mid-completion** surfaces as `404 SERIES_NOT_FOUND`
  (still no write).
- **KNOWN LIMITATION — a direct non-null `coverImageKey` PATCH does NOT
  invalidate an outstanding upload intent.** Only the explicit-`null`
  (Remove) form clears `pendingCoverImageKey`; `PATCH { coverImageKey:
  "<some string>" }` deliberately leaves it untouched (unchanged,
  pre-2026-08-18 behavior). So if an upload was presigned and then an admin
  writes a cover key directly by hand, a completion of that still-valid
  pending intent will legitimately win the compare-and-set afterwards and
  replace the hand-written value — it has not been superseded, because
  nothing revoked its intent. This is NOT the TOCTOU race the 2026-08-18
  hardening closes (there is no stale read involved: the intent genuinely
  is still current at write time); it is a consequence of the documented
  `coverImageKey` three-state semantics above. **To invalidate an
  in-flight upload, use the `null` (Remove) form**, which clears both
  columns in one statement.

These semantics are proven by deterministic service-level interleaving tests
(`src/series/series.service.spec.ts`, "atomic final persistence
(concurrency / TOCTOU hardening)" — the interfering admin action is executed
INSIDE the mocked storage `HEAD`, never by timing/sleeps) plus API-level
tests in `test/series.e2e-spec.ts`.

**Replace semantics:** the OLD `coverImageKey` stays authoritative until a
NEW upload is independently verified — a failed verification (any of checks
2–6 above) leaves `Series.coverImageKey` completely untouched, never
partially cleared or overwritten; a failure at check 5 or 6 ALSO leaves
`pendingCoverImageKey` untouched (the upload can be retried against the same
pending key without re-presigning). A successful replacement overwrites the
pointer with the new key.

**Orphan behavior (documented, not automated):** replacing a cover does
**not** delete the previous object from R2 — `SeriesService` never calls
`StorageService.deleteObject` for a cover. The old object becomes an orphan
once nothing references it; cleaning up orphaned cover objects is not
implemented by this work unit and would need a separate, explicit sweep
(mirroring the existing HLS-generation janitor's pattern, `TranscodeJanitorService`,
if ever built for covers). **A cover that is presigned but never completed
(the client abandons the upload, or the object genuinely never lands in
R2) is likewise an orphan-in-waiting**: `pendingCoverImageKey` records the
intent server-side, but nothing in this work unit deletes the R2 object at
that key, and an abandoned/failed-completion object can sit in R2
indefinitely (bounded only by `MAX_SERIES_COVER_UPLOAD_BYTES` per object,
and by the fact that every presign requires an authenticated, admin-guarded,
rate-limited (`ADMIN_MEDIA_UPLOAD_INITIATE_RATE_LIMIT`) request). As with
the replaced-cover orphan case above, a bounded, explicit sweep (mirroring
`TranscodeJanitorService`) is the recommended future hardening — not
implemented here.

**A completion that LOSES the 2026-08-18 compare-and-set is a third orphan
case, and is deliberately left as one:** its object was genuinely uploaded
to R2 and verified, but never became the cover. Nothing deletes it. Deleting
it on the losing path is explicitly NOT done here — a stale, unreferenced
object is strictly safer than deleting an object that some other in-flight
request may still be about to reference, and the correct place to reclaim it
is the same bounded orphan-cleanup sweep the two cases above already need.
**No automatic cleanup of any kind exists for series cover objects today.**

### `POST /admin/series/:id/archive`

Safe (soft) archive — the PRIMARY "delete" action. Sets `archivedAt` to
now. **Idempotent**: calling it again on an already-archived series is a
no-op (row returned unchanged, no timestamp drift). Unknown `id` → `404
SERIES_NOT_FOUND`. Returns `200 SeriesDto` (`@HttpCode(200)`).

### `POST /admin/series/:id/unarchive`

Reverses `archive` by clearing `archivedAt`. Idempotent the same way.
Unknown `id` → `404 SERIES_NOT_FOUND`. Returns `200 SeriesDto`
(`@HttpCode(200)`).

### `DELETE /admin/series/:id`

The guarded HARD delete — actually removes the `Series` row. Before
deleting, counts `Video` rows sharing this `seriesId` with
`lifecycleState: "published"`; if that count is `> 0`, the delete is
**refused** with `409 SERIES_HAS_PUBLISHED_EPISODES` and nothing is
written. This is the only `Series` route that reads the `Video` table, and
it is read-only (a count) — a successful delete never touches, updates, or
deletes any `Video` row, so every episode's `seriesId` and every other field
is preserved exactly. Archived series are deletable too (archive state does
not affect this check) as long as they have no published episodes. Unknown
`id` → `404 SERIES_NOT_FOUND`. On success, returns `204 No Content`
(`@HttpCode(204)`, empty body). For a series that still has published
episodes, use `archive` instead — it has no such restriction.

## `SeriesDto` (`src/series/series.types.ts`)

| Field | Type |
|---|---|
| `id` | string |
| `title` | string |
| `coverImageKey` | string \| null |
| `sortOrder` | number |
| `createdAt` | string (ISO 8601) |
| `updatedAt` | string (ISO 8601) |
| `archivedAt` | string (ISO 8601) \| null — `null` = active |

## `SeriesWithCoverDto` (`src/series/series.types.ts`, 2026-08-14 re-freeze)

Returned by `GET /admin/series`, `GET /admin/series/:id`, and
`POST /admin/series/:id/cover/complete` — every `SeriesDto` field above,
plus:

| Field | Type |
|---|---|
| `coverUrl` | string \| null |

`coverUrl` is a presigned R2 GET URL (`StorageService.createPresignedGetUrl`,
1-hour expiry, minted fresh per request, never persisted) resolved from
`coverImageKey`, or `null` when `coverImageKey` is unset — including for an
archived or episode-less series (this DTO/these routes never read `Video` at
all). Reuses the exact same `resolveSeriesCoverUrl` helper the public
`GET /series`/`GET /series/:id` surface already uses, so the two can never
drift.

## Access-tier model

- `Video.accessTierOverride` (`String?` — nullable, no default; added by an
  additive `ADD COLUMN` migration with no drop/data change) is the **DB-backed
  per-episode tier**. It is exposed only on `AdminMediaDto`, never on the
  public `VideoResponseDto`.
- **Backfilled for every row.** A one-time, additive, data-only migration
  (`prisma/migrations/20260725070000_backfill_video_access_tier_override`)
  filled every previously-`NULL` row (all 40 pre-existing rows at the time it
  ran) with the value the old default rule already derived for it
  (`episodeNumber > FREE_EPISODE_LIMIT` → `"premium"`, else `"free"`).
  `prisma/seed.ts` now sets it explicitly on every freshly seeded row, and
  `POST /admin/media` sets it explicitly at creation time (see above) — so
  every row, old or new, carries a non-null explicit value in normal
  operation.
- **Enforcement reads the DB value.** `GET /videos/:id/stream`'s premium
  guard calls `EntitlementsService.resolveEpisodePremium`, which treats
  `accessTierOverride = "premium"`/`"free"` as authoritative regardless of
  `episodeNumber`. `episodeNumber`-based derivation (`isEpisodePremium`,
  `episodeNumber > FREE_EPISODE_LIMIT` where `FREE_EPISODE_LIMIT = 5`) is
  retained only as (a) the value the backfill/seed/create-time default
  derives from, and (b) a null-safety fallback for a row somehow still
  `null` post-backfill.
- **Public exposure (work unit "Episode Access-Tier + Category Contract
  Hardening").** The RESOLVED tier (never the raw override) is now also
  additively exposed on the public `VideoResponseDto.accessTier` field
  (`/videos/feed`, `/videos/:id`, and each episode embedded in
  `/series/:id` — see `README.md`'s public contract section) and, for
  convenience, alongside the raw override on this admin route's own
  `AdminMediaDto.accessTier`. Both are computed by the exact same
  `resolveAccessTier` function `GET /videos/:id/stream`/`/playback` already
  enforce, so an admin PATCH here is immediately reflected on the public
  surface the next time that episode is read, with no separate cache or
  propagation delay.
- **No payments.** This is a manually admin-set tier, not a payment-driven
  entitlement. Real entitlement/premium enforcement (whether a given
  *user* has an active premium entitlement) is unchanged and lives entirely
  in the pre-existing `Entitlement` model / `EntitlementsService` (Phase
  10) — see the main `README.md`'s "Entitlements API" section. This
  contract does not add, remove, or change any payment or entitlement
  logic.

## Rate limiting (added by the 2026-07-30 re-freeze)

**`429` is reachable on every route this contract documents**, including
`GET /admin/whoami` and every `admin/media`/`admin/series` route above —
not called out at the 2026-07-25 freeze, but present since Phase 12, work
unit 12A-B1 (`src/app.module.ts`, `src/common/rate-limit.constants.ts`),
which predates that freeze.

- `ThrottlerGuard` is registered globally as an `APP_GUARD`
  (`src/app.module.ts`) with a single named (`"default"`) throttler:
  **300 requests per 60 seconds, per IP.** No admin/media/series controller
  or route in this contract carries a `@Throttle()`/`@SkipThrottle()`
  override, so every route above is subject to exactly this generous
  default — deliberately high enough that no legitimate admin-dashboard
  traffic pattern comes close to tripping it; it exists purely as coarse
  abuse protection, not a meaningful per-route limit for this surface.
- This is coarse, **in-memory, per-application-instance** throttling — it
  does not survive a restart and is not shared across multiple backend
  instances (a persistent/shared IP-rate store is explicitly deferred to
  Phase 13, per `DECISIONS.md`). It is a separate mechanism from the
  persistent PostgreSQL account-lockout state referenced in the "Auth
  (context)" table's routes below, which is unrelated to this contract's
  admin surface.
- The **"Auth (context)" table's own routes carry tighter, route-specific
  overrides** that also predate this freeze and were likewise never listed
  in the error-codes table below: `POST /auth/login` is 5 requests/minute/IP
  and `POST /auth/refresh` is 30 requests/minute/IP (`LOGIN_RATE_LIMIT`/
  `REFRESH_RATE_LIMIT`, `src/common/rate-limit.constants.ts`) — these
  override, rather than add to, the 300/60s default for just those two
  routes. (`POST /auth/register`, also unauthenticated but not itself part
  of this admin contract, carries its own 3/10min override on the same
  mechanism.)
- **Response shape on `429`:** `ThrottlerGuard` throws `ThrottlerException`
  (a plain Nest `HttpException`, not an `AppException`), so it is caught by
  `AppExceptionFilter`'s generic `HttpException` branch — same envelope
  convention as every other unrecognized-field/validation `400` documented
  in "Conventions" above, just with `statusCode: 429`:
  `{ "statusCode": 429, "code": "HTTP_ERROR", "message": "Too many requests. Please try again later." }`
  (the message text is `ThrottlerModule.forRoot`'s configured
  `errorMessage`). There is no dedicated `AppErrorCode` for rate limiting.

## Request body size limit (added by the 2026-07-30 re-freeze)

Also present since Phase 12 (work unit 12A-B2, `src/main.ts`) and also never
previously listed here: every JSON/urlencoded request body on **every**
route in this backend, including every route in this contract, is capped at
**256kb** (`JSON_BODY_LIMIT`, `src/main.ts`). A body larger than that is
rejected with **`413`** before Nest's routing/validation pipeline (and
therefore before any controller/service code, including `AdminMediaService`/
`SeriesService`) ever inspects it. In practice, no route this contract
documents can realistically hit this ceiling — every admin body here is a
metadata-only JSON object (the largest, `CreateMediaUploadDto`, is a small,
bounded set of short string/number/boolean fields; real media/thumbnail
bytes never transit this JSON body pipeline at all, since `POST /admin/media`
and the cover/thumbnail routes only ever return a **presigned URL** for the
client to `PUT` bytes directly to object storage — see "Explicitly still
GATED" below) — but the limit is a real, global constraint on this API
surface and is documented here for completeness, not because any route
above is expected to trip it. **Response shape:** the same `AppExceptionFilter`
envelope as `429` above — `body-parser`'s `PayloadTooLargeError` is an
`http-errors`-shaped client error, not a Nest `HttpException`, so it is
caught by the filter's dedicated exposed-client-error branch and returned as
`{ "statusCode": 413, "code": "HTTP_ERROR", "message": "<body-parser's own message>" }`.

## Error codes referenced by the routes above

| Code | HTTP status | Meaning |
|---|---|---|
| `VIDEO_NOT_FOUND` | 404 | No `Video` row matches the given `id` |
| `MEDIA_FILE_NOT_FOUND` | 400 | `complete-upload`: no upload started, or no object found at the presigned key |
| `SERIES_NOT_FOUND` | 404 | No `Series` row matches the given `id` |
| `SERIES_ALREADY_EXISTS` | 409 | `POST /admin/series`: duplicate `id` |
| `SERIES_HAS_PUBLISHED_EPISODES` | 409 | `DELETE /admin/series/:id`: series still has `published` episodes |
| `DUPLICATE_EPISODE_NUMBER` | 409 | `POST /admin/media` or `PATCH /admin/media/:id`: `(seriesId, episodeNumber)` collision |
| `EMPTY_MEDIA_METADATA_UPDATE` | 400 | `PATCH /admin/media/:id`: body has none of the 7 editable fields |
| `EMPTY_SERIES_UPDATE` | 400 | `PATCH /admin/series/:id`: body has none of the 3 editable fields |
| `INVALID_MEDIA_LIFECYCLE_TRANSITION` | 400 | `complete-upload`/`publish`/`unpublish`: not a valid state edge |
| `ADMIN_ROLE_REQUIRED` | 403 | `AdminGuard`: caller is authenticated but not an admin (or `request.user` missing) |
| `INVALID_ACCESS_TOKEN` | 401 | `JwtAuthGuard`: missing/malformed/expired/invalid token |
| `HTTP_ERROR` | 400 (usually); also 429 (rate limit, see "Rate limiting" above) and 413 (body too large, see "Request body size limit" above) | Generic class-validator/`forbidNonWhitelisted` failure, or a generic exposed `HttpException`/`http-errors`-shaped client error from outside the service layer — see "Conventions" above |
| `INTERNAL_ERROR` | 500 | Unhandled exception fallback |
| `SERIES_COVER_KEY_INVALID` | 400 | `POST /admin/series/:id/cover/complete`: `key` does not belong to this series' cover prefix (2026-08-14 re-freeze) |
| `SERIES_COVER_CONTENT_TYPE_NOT_ALLOWED` | 409 | `POST /admin/series/:id/cover/complete`: the object's real `Content-Type` is not an allowed cover MIME type (2026-08-14 re-freeze) |
| `SERIES_COVER_SIZE_OUT_OF_BOUND` | 409 | `POST /admin/series/:id/cover/complete`: the object's real size is outside `1`–`10485760` bytes (2026-08-14 re-freeze) |
| `SERIES_COVER_KEY_SUPERSEDED` | 409 | `POST /admin/series/:id/cover/complete`: `key` is well-formed for this series but matches neither its current `pendingCoverImageKey` nor its current `coverImageKey` — a superseded/stale/replayed key (2026-08-15, fix cycle 1). Also returned when a completion LOSES the final atomic compare-and-set, i.e. the intent was removed or replaced while this completion was verifying the object in storage (2026-08-18 hardening) — deliberately the same code for the same semantic state |

## Explicitly still GATED (do NOT wire as real in 11F-6)

The admin dashboard must keep these mocked / visibly pending — none of them
make a real network call anywhere in this backend today:

- **Real R2 presigned byte uploads.** `POST /admin/media`,
  `POST /admin/media/:id/cover`, `POST /admin/media/:id/thumbnail`, and (as
  of the 2026-08-14 re-freeze) `POST /admin/series/:id/cover` all call
  `StorageService.createPresignedPutUrl`; `POST /admin/media/:id/complete-upload`
  and `POST /admin/series/:id/cover/complete` call
  `StorageService.headObject`/`objectExists` — **every test that exercises
  these routes mocks `StorageService`** (`src/storage/storage.service.ts`
  constructs a real `S3Client` only when the app actually boots against real
  `OBJECT_STORAGE_*` env vars, which this credential-free slice never
  supplies with real credentials). The returned `upload.url` is a real
  presigned-URL shape but nothing has verified an actual byte can be PUT to
  it against a real bucket. This is the R2 cutover, still gated behind work
  unit `11A-3`/`11B-3-real`.
- **Thumbnail ingestion to a real bucket.** `ThumbnailService`
  (`src/thumbnails/thumbnail.service.ts`) is not wired to any HTTP route at
  all — `ThumbnailsModule` is not imported into `AppModule`. Not part of
  this contract's admin surface.
- **Live-stream cutover.** `GET /videos/:id/stream` still serves from the
  local `STORAGE_ROOT` filesystem, not from `objectStorageKey`/R2. An
  admin-created row has no real playable file until 11A-3 lands.

## Cross-reference

See the main `README.md`'s "Admin content management API (Phase 11, work
units 11E-1..11E-4)" section for the original narrative writeup this
contract formalizes and freezes, and "Media operations (Phase 11 —
credential-free)" for the thumbnail/importer pieces referenced above as
still-gated context.
