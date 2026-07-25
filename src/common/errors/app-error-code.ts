export enum AppErrorCode {
  VIDEO_NOT_FOUND = 'VIDEO_NOT_FOUND',
  MEDIA_FILE_NOT_FOUND = 'MEDIA_FILE_NOT_FOUND',
  INVALID_MEDIA_RANGE = 'INVALID_MEDIA_RANGE',
  INVALID_STORAGE_PATH = 'INVALID_STORAGE_PATH',
  // Phase 8, work unit 8-B5 (auth)
  EMAIL_ALREADY_REGISTERED = 'EMAIL_ALREADY_REGISTERED',
  /**
   * Deliberately generic: used for BOTH "email not found" and "wrong
   * password" on login, and for any invalid/expired/revoked/reused refresh
   * token on refresh. Never split this into more specific codes for those
   * cases — doing so would let a caller enumerate registered emails or
   * distinguish "your token was stolen and already rotated" from "you typo'd
   * it", which is a real security regression, not a UX nicety.
   */
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  INVALID_REFRESH_TOKEN = 'INVALID_REFRESH_TOKEN',
  // Phase 8, work unit 8-B6 (access-token verification guard)
  /**
   * Deliberately generic, matching the `INVALID_CREDENTIALS` /
   * `INVALID_REFRESH_TOKEN` precedent above: used for a missing/malformed
   * `Authorization` header, an expired access token, and an invalid-signature
   * (tampered or forged) access token alike. Never split this into more
   * specific codes — doing so would let a caller distinguish "you forgot the
   * header" from "your token's signature is wrong" from "your token expired",
   * which leaks unnecessary detail about why authentication failed.
   */
  INVALID_ACCESS_TOKEN = 'INVALID_ACCESS_TOKEN',
  // Phase 10, work unit 10-B3 (premium entitlement enforcement)
  /**
   * Returned when an authenticated caller lacks an active entitlement for a
   * premium-tier episode. Deliberately does not distinguish "never
   * entitled" from "expired" from "revoked" (see DECISIONS.md "Phase 10
   * approved..." entry, default decision 4) — all three collapse to this
   * one code/403, keeping the contract simple and avoiding leaking
   * granular entitlement history to the client.
   */
  ENTITLEMENT_REQUIRED = 'ENTITLEMENT_REQUIRED',
  // Phase 10, work unit 10-B5 (dev-only entitlement grant/revoke tooling)
  /** Returned when a dev-only route is hit while DEV_TOOLS_ENABLED is not 'true'. */
  DEV_TOOLS_DISABLED = 'DEV_TOOLS_DISABLED',
  /**
   * Returned by the dev-only grant/revoke routes when `targetUserId` does not
   * match any existing user, instead of letting a Prisma foreign-key
   * violation surface as an unstructured 500.
   */
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  // Phase 11, work unit 11B-1 (media lifecycle state machine)
  /**
   * Returned when a requested media lifecycle transition (e.g.
   * `published` -> `draft`) is not one of the explicitly allowed edges —
   * see `MediaLifecycleService`/`MEDIA_LIFECYCLE_TRANSITIONS`. Also covers
   * an unrecognized `from`/`to` state string, rather than letting an
   * invalid string reach a Prisma write.
   */
  INVALID_MEDIA_LIFECYCLE_TRANSITION = 'INVALID_MEDIA_LIFECYCLE_TRANSITION',
  // Phase 11, work unit 11B-2 (admin role + AdminGuard)
  /**
   * Returned by `AdminGuard` when the authenticated caller's `User.role` is
   * not `"admin"` — deliberately does not distinguish "no such user
   * anymore" from "exists but not an admin" (same 403), matching the
   * `INVALID_CREDENTIALS`-style precedent of not leaking which specific
   * condition failed.
   */
  ADMIN_ROLE_REQUIRED = 'ADMIN_ROLE_REQUIRED',
  // Phase 11, work unit 11D-2b (ffmpeg thumbnail generation)
  /**
   * Returned when `ThumbnailService.generate` is asked to read a source
   * video whose extension is not in the supported list — deliberately
   * distinct from `MEDIA_FILE_NOT_FOUND` (the file exists, but this service
   * refuses to process it).
   */
  UNSUPPORTED_MEDIA_FORMAT = 'UNSUPPORTED_MEDIA_FORMAT',
  /** Returned when a requested thumbnail capture timestamp is not a finite, non-negative number of seconds. */
  INVALID_THUMBNAIL_TIMESTAMP = 'INVALID_THUMBNAIL_TIMESTAMP',
  /**
   * Returned when the generated thumbnail's measured width does not match
   * the requested width, or either dimension is not a positive number —
   * caught before the artifact is ever ingested into object storage.
   */
  THUMBNAIL_DIMENSION_MISMATCH = 'THUMBNAIL_DIMENSION_MISMATCH',
  /**
   * Returned when the injected `ThumbnailClient` or the ingestion call to
   * `StorageService.putObject` fails. Deliberately does not echo the
   * underlying error's raw message (which could contain an absolute
   * filesystem path) — full detail is logged server-side, redacted, instead.
   */
  THUMBNAIL_GENERATION_FAILED = 'THUMBNAIL_GENERATION_FAILED',
  // Phase 11, work unit 11D-1-dryrun (read-only dry-run importer)
  /**
   * Returned when `MediaDryRunService.inspect` is called with a missing or
   * empty `folderPath`. This service has no default path — it never falls
   * back to `STORAGE_ROOT` or any other directory, so an absent path is
   * always a caller error, not something to silently default around.
   */
  DRY_RUN_FOLDER_PATH_REQUIRED = 'DRY_RUN_FOLDER_PATH_REQUIRED',
  /**
   * Returned when the passed `folderPath` does not resolve to an existing,
   * readable directory (missing, or exists but is a file, not a folder).
   */
  DRY_RUN_FOLDER_NOT_FOUND = 'DRY_RUN_FOLDER_NOT_FOUND',
  // Phase 11, work unit 11E-2 (admin media metadata edit)
  /**
   * Returned by `PATCH /admin/media/:id` when the request body contains
   * none of the seven updatable metadata fields — `UpdateMediaMetadataDto`
   * itself has no way to require "at least one of N optional fields" as a
   * single decorator, so this is checked in `AdminMediaService.updateMetadata`.
   */
  EMPTY_MEDIA_METADATA_UPDATE = 'EMPTY_MEDIA_METADATA_UPDATE',
  // Phase 11, work unit 11E-4 (additive Series model + admin CRUD)
  /** Returned by `PATCH /admin/series/:id` and internal lookups when no `Series` row matches the given id. */
  SERIES_NOT_FOUND = 'SERIES_NOT_FOUND',
  /**
   * Returned by `POST /admin/series` when a `Series` row with the given
   * `id` already exists — a clean, structured 409 instead of letting a
   * Postgres unique-constraint violation (`P2002`) surface as an
   * unstructured 500.
   */
  SERIES_ALREADY_EXISTS = 'SERIES_ALREADY_EXISTS',
  /**
   * Returned by `PATCH /admin/series/:id` when the request body contains
   * none of the three updatable fields (`title`/`coverImageKey`/
   * `sortOrder`) — `UpdateSeriesDto` itself has no way to require "at least
   * one of N optional fields" as a single decorator, matching the
   * `EMPTY_MEDIA_METADATA_UPDATE` precedent (work unit 11E-2).
   */
  EMPTY_SERIES_UPDATE = 'EMPTY_SERIES_UPDATE',
  // Phase 11, work unit 11F-1 (series read-detail + safe archive + guarded hard-delete)
  /**
   * Returned by `DELETE /admin/series/:id` when at least one `Video` row
   * with that `seriesId` is currently `lifecycleState: "published"` — the
   * hard delete is refused (the row is NOT deleted) rather than silently
   * orphaning a still-live episode's grouping. Deleting the metadata-only
   * `Series` row is safe only once no published episode references it;
   * archiving (`POST /admin/series/:id/archive`) is the reversible,
   * always-available alternative that never has this restriction.
   */
  SERIES_HAS_PUBLISHED_EPISODES = 'SERIES_HAS_PUBLISHED_EPISODES',
}
