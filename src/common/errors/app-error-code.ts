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
  // Phase 11, work unit 11F-3 (duplicate episode-number-within-series validation)
  /**
   * Returned by `POST /admin/media` when a `Video` row with the same
   * `seriesId` AND `episodeNumber` already exists (no row is created), and
   * by `PATCH /admin/media/:id` when the request body's `episodeNumber`
   * collides with a DIFFERENT `Video` row (`id !=` the one being edited) in
   * the same series (no update is applied). Since `seriesId` is not
   * editable via the metadata PATCH (see `UpdateMediaMetadataDto`), the
   * collision check always uses the row's existing, unchanged `seriesId`.
   * Changing `episodeNumber` to the row's own current value is a no-op and
   * is explicitly NOT treated as a collision.
   */
  DUPLICATE_EPISODE_NUMBER = 'DUPLICATE_EPISODE_NUMBER',
  // Phase 12, work unit 12B-B2 (session management)
  /**
   * Returned by `DELETE /auth/sessions/:id` when no `Session` row with the
   * given id belongs to the authenticated caller — deliberately used for
   * BOTH "no such session id at all" and "that session id exists but
   * belongs to a different account" (the exact same code/404 either way).
   * Never split into a distinct "not yours" code/403: doing so would let a
   * caller enumerate which session ids exist for other accounts, which is
   * the same anti-enumeration rationale `INVALID_CREDENTIALS`/
   * `INVALID_REFRESH_TOKEN` already establish elsewhere in this file.
   */
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  // Phase 12, work unit 12B-B3 (password reset)
  /**
   * Returned by `POST /auth/password-reset/confirm` for ANY invalid-token
   * condition — the token does not exist, was already used, or has expired
   * — collapsing all three into the exact same generic code/status,
   * mirroring the `INVALID_REFRESH_TOKEN`/`INVALID_CREDENTIALS`
   * anti-enumeration precedent: never let a caller distinguish "this token
   * never existed" from "someone already used it" from "you waited too
   * long", which would otherwise leak information about account/reset-flow
   * state.
   */
  INVALID_PASSWORD_RESET_TOKEN = 'INVALID_PASSWORD_RESET_TOKEN',
  // Phase 12, work unit 12C-B1 (account deletion)
  /**
   * Returned by `POST /users/me/deletion` when the authenticated caller's
   * `User.role` (loaded fresh from the database, never trusted off the
   * access token) is not `"user"` — DECISIONS.md decision 1 restricts
   * self-service account deletion to normal user accounts; deleting a
   * privileged (`admin`/other) account is a separate, not-yet-built process.
   * Deliberately DISTINCT from the generic `INVALID_CREDENTIALS`: unlike a
   * wrong password, this is only reachable AFTER the correct current
   * password was already verified (see `AuthService.deleteAccount`'s doc
   * comment for why that ordering matters), so a specific, descriptive code
   * here does not create a new information-leak surface for a caller who
   * does not already hold the account's real password.
   */
  ACCOUNT_DELETION_FORBIDDEN = 'ACCOUNT_DELETION_FORBIDDEN',
  // Phase 11, work unit 11L-B3 (hardened admin-upload completion)
  /**
   * Returned by `POST /admin/media/:id/complete-upload` when the uploaded
   * object's real size (`HeadObject`'s `ContentLength`, from
   * `StorageService.headObject`) does not exactly equal
   * `Video.expectedSizeBytes` — the value the client itself declared at
   * `POST /admin/media` (initiate) time. Distinct from
   * `MEDIA_FILE_NOT_FOUND` (the object exists, but is not the object that
   * was expected) and from `UPLOAD_CONTENT_TYPE_MISMATCH` (a different
   * verification axis) so a caller/operator can tell exactly which
   * expectation failed. The row's `lifecycleState` stays `draft` and remains
   * retryable — no partial data is written. The message states only the
   * mismatch itself (expected vs. actual size), never the bucket, endpoint,
   * object key, or any signed URL.
   */
  UPLOAD_SIZE_MISMATCH = 'UPLOAD_SIZE_MISMATCH',
  /**
   * Returned by `POST /admin/media/:id/complete-upload` when the uploaded
   * object's real `Content-Type` (`HeadObject`'s `ContentType`) does not
   * exactly equal `Video.expectedContentType` — the value the client itself
   * declared at initiate time (today always `'video/mp4'`, per
   * `CreateMediaUploadDto`'s `@IsIn` allow-list). Same retry-safe/no-leak
   * contract as `UPLOAD_SIZE_MISMATCH` above: the row stays `draft`, and the
   * message states only expected-vs-actual content type.
   */
  UPLOAD_CONTENT_TYPE_MISMATCH = 'UPLOAD_CONTENT_TYPE_MISMATCH',
  // Phase 11, work unit 11M-B1/B2 (GET /videos/:id/playback)
  /**
   * Returned by `GET /videos/:id/playback` when a `published` row (it
   * already passed the `VIDEO_NOT_FOUND`/entitlement gates) has neither a
   * non-empty `objectStorageKey` nor a non-empty `storageKey` —
   * `resolvePlaybackSource` (`playback-source.util.ts`) fails CLOSED rather
   * than returning a bogus/empty playback source. Deliberately distinct
   * from `MEDIA_FILE_NOT_FOUND` (that code means "a local file's storageKey
   * resolved, but nothing exists on disk at that path"; this one means "the
   * row itself declares no storage identity at all") and from a bare 500 —
   * this is a data-integrity condition the server can identify and refuse
   * cleanly, not an unexpected crash. The message never includes any
   * bucket, endpoint, or key value.
   */
  MEDIA_PLAYBACK_SOURCE_UNAVAILABLE = 'MEDIA_PLAYBACK_SOURCE_UNAVAILABLE',
  // Slice 11O (FFmpeg/HLS worker proof on ONE synthetic video)
  /**
   * Returned when `SyntheticSourceService` cannot produce or validate the
   * disposable synthetic MP4 fixture (ffmpeg generation failure, or the
   * generated file fails its own ffprobe sanity check — wrong stream
   * shape, out-of-band duration). Never a company/user media failure: this
   * service only ever touches its own `fs.mkdtemp` output.
   */
  HLS_SOURCE_GENERATION_FAILED = 'HLS_SOURCE_GENERATION_FAILED',
  /**
   * Returned when a single rung's ffmpeg transcode+package invocation exits
   * non-zero or otherwise fails. Per the 2026-08-10 Slice 11O approval, one
   * failed rung fails the WHOLE job — a partial ladder is never packaged.
   */
  HLS_TRANSCODE_FAILED = 'HLS_TRANSCODE_FAILED',
  /**
   * Returned by `HlsPackageValidator` when the locally-produced HLS package
   * fails any binding local-validation check (missing/zero-byte artifact,
   * unparseable playlist, dimension/duration/segment-count mismatch, or a
   * path that resolves outside the package's temp root). Local failure
   * means STOP — no R2 byte is ever written (2026-08-10 approval, binding
   * constraint 6).
   */
  HLS_PACKAGE_VALIDATION_FAILED = 'HLS_PACKAGE_VALIDATION_FAILED',
  /**
   * Returned when the gated real-R2 upload phase cannot verify every
   * expected uploaded object (HEAD missing, size mismatch, wrong
   * Content-Type) — never used in the local-only path, which never touches
   * R2 at all.
   */
  HLS_UPLOAD_VERIFICATION_FAILED = 'HLS_UPLOAD_VERIFICATION_FAILED',
  /**
   * Returned when the binding cleanup step (2026-08-10 approval, item 10)
   * cannot prove every recorded uploaded object was actually deleted —
   * surfaced loudly rather than silently swallowed, per the approval's
   * "unprovable cleanup ⇒ STOP + prominent report" requirement.
   */
  HLS_CLEANUP_VERIFICATION_FAILED = 'HLS_CLEANUP_VERIFICATION_FAILED',
  // Slice 11P (production transcoding lifecycle)
  /**
   * Returned by `POST /admin/media/:id/complete-upload` when
   * `TRANSCODE_ENABLED=true` and the durable DB-intent write
   * (`TranscodeIntentService.recordIntent`, run inside the SAME
   * `prisma.$transaction` as the upload-completion ready-transition) fails
   * for any reason — the whole transaction rolls back, so the row's
   * `lifecycleState` stays exactly where it was (`draft`), never silently
   * treated as "scheduled". This RESOLVES the carried 11N/11O REQUIRED
   * concern (control workspace DECISIONS.md, "2026-08-10 — Slice 11P
   * APPROVED..." entry, binding constraint 5): a durable-intent failure is
   * loud and explicit, not swallowed — the caller may safely retry
   * `complete-upload` once the underlying issue (e.g. a database outage) is
   * resolved. Deliberately distinct from a queue/Redis-enqueue failure
   * (which stays best-effort and non-fatal, per `TranscodeIntentService
   * .enqueueBestEffort`'s doc comment) — this code is ONLY ever used for the
   * durable DB write itself failing.
   */
  MEDIA_PROCESSING_INTENT_FAILED = 'MEDIA_PROCESSING_INTENT_FAILED',
  /**
   * Returned by `POST /admin/media/:id/publish` when the row is an
   * HLS-pipeline row (`Video.processingState IS NOT NULL`) whose processing
   * has not yet reached a verified-ready generation
   * (`processingState !== "ready"` OR `hlsMasterKey` is still `null`) — the
   * 2026-08-10 Slice 11P approval, binding constraint 10. Rows with
   * `processingState === null` (every legacy/local row, and the pre-HLS
   * published R2 fixture row) are completely unaffected by this check and
   * never receive this code — their publish behavior is byte-identical to
   * before this slice.
   */
  HLS_NOT_READY_FOR_PUBLISH = 'HLS_NOT_READY_FOR_PUBLISH',
  // Slice 11Q (private HLS delivery gateway)
  /**
   * Returned by `GET /videos/:id/playback` when a row cleanly qualifies for
   * the HLS branch (`processingState === 'ready'` and `hlsMasterKey` set,
   * with a well-formed derivable prefix) but `HLS_GATEWAY_BASE_URL` and/or
   * `HLS_TOKEN_SECRET` are not configured — i.e. `TRANSCODE_ENABLED` is
   * somehow `true` (the only way a row could ever reach this state) while
   * the SEPARATE HLS gateway config is missing. This should be
   * unreachable in the real shipped default (`TRANSCODE_ENABLED=false`
   * means no row can ever reach `processingState: 'ready'` with a real
   * `hlsMasterKey`), but `VideosService` checks for it explicitly anyway
   * rather than letting `mintHlsToken` be called with an empty secret or
   * assembling a URL against an empty base — fails CLOSED with a message
   * that names only which two variables are missing, never their values
   * (there is nothing secret to leak either way: absence, not a wrong
   * value, is what's being reported).
   */
  HLS_GATEWAY_NOT_CONFIGURED = 'HLS_GATEWAY_NOT_CONFIGURED',
}
