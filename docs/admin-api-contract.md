# Admin API Contract

**Frozen for Slice #4 wiring (2026-07-25).** This document is the
authoritative, frozen contract for every admin-guarded route this backend
currently exposes. It was produced by work unit **11F-5** (the gate before
any admin/mobile wiring — see the control workspace's `DECISIONS.md`,
"2026-07-25 — Phase 11 credential-free endpoint slice: formal approval
(ratify + expand) → Slice #4") and reflects exactly what is implemented on
`short-drama-backend` as of commit `1214f2c` (11F-1..11F-4 landed). It
documents **only** routes, fields, shapes, status codes, and error codes that
actually exist in this repository today — nothing here is aspirational.

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
| `category` | string | 1–100 chars, required |
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
| `category` | string | 1–100 chars |
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
`?includeArchived=true` to include them too. Returns `200 SeriesDto[]`,
ordered by `sortOrder` then `id`. No pagination on this route.

### `GET /admin/series/:id`

Returns `200 SeriesDto` (archived or not — only the default `list` view
hides archived rows), or `404 SERIES_NOT_FOUND` for an unknown `id`.

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
`201 SeriesDto`.

### `PATCH /admin/series/:id`

Body (`UpdateSeriesDto`): any subset of `title` (1–200 chars),
`coverImageKey` (1–500 chars), `sortOrder` (int `>= 0`) — same constraints
as create. `id` itself is not accepted in the body (immutable; rejected by
the global whitelist). At least one field must be present, or `400
EMPTY_SERIES_UPDATE`. Unknown `id` → `404 SERIES_NOT_FOUND`. Returns `200
SeriesDto` (updated).

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
- **No payments.** This is a manually admin-set tier, not a payment-driven
  entitlement. Real entitlement/premium enforcement (whether a given
  *user* has an active premium entitlement) is unchanged and lives entirely
  in the pre-existing `Entitlement` model / `EntitlementsService` (Phase
  10) — see the main `README.md`'s "Entitlements API" section. This
  contract does not add, remove, or change any payment or entitlement
  logic.

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
| `HTTP_ERROR` | 400 (usually) | Generic class-validator/`forbidNonWhitelisted` failure — see "Conventions" above |
| `INTERNAL_ERROR` | 500 | Unhandled exception fallback |

## Explicitly still GATED (do NOT wire as real in 11F-6)

The admin dashboard must keep these mocked / visibly pending — none of them
make a real network call anywhere in this backend today:

- **Real R2 presigned byte uploads.** `POST /admin/media`,
  `POST /admin/media/:id/cover`, and `POST /admin/media/:id/thumbnail` all
  call `StorageService.createPresignedPutUrl`, and
  `POST /admin/media/:id/complete-upload` calls
  `StorageService.objectExists` — **every test that exercises these routes
  mocks `StorageService`** (`src/storage/storage.service.ts` constructs a
  real `S3Client` only when the app actually boots against real
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
