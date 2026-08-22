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
  // Work unit "SERIES COVER UPLOAD BACKEND CONTRACT" (approved 2026-08-14)
  /**
   * Returned by `POST /admin/series/:id/cover/complete` when `key` does not
   * have the exact `admin-series/<this series' id>/cover/<uuid>` shape this
   * series' own presign step would have minted — e.g. it belongs to a
   * DIFFERENT series, an unrelated `admin-media/...` object, or is simply
   * malformed. Checked BEFORE any `StorageService.headObject` call, so a
   * crafted key is rejected without ever asking storage about it.
   */
  SERIES_COVER_KEY_INVALID = 'SERIES_COVER_KEY_INVALID',
  /**
   * Returned by `POST /admin/series/:id/cover/complete` when the uploaded
   * object's real, R2-reported `Content-Type` (`StorageService.headObject`)
   * is not one of `ALLOWED_SERIES_COVER_CONTENT_TYPES`
   * (`series/series-cover.constants.ts`) — checked against the actual HEAD
   * response, not the client's presign-time declaration (nothing is
   * persisted between presign and complete to compare against; see
   * `SeriesService.createCoverUpload`'s doc comment). `Series.coverImageKey`
   * is left untouched.
   */
  SERIES_COVER_CONTENT_TYPE_NOT_ALLOWED = 'SERIES_COVER_CONTENT_TYPE_NOT_ALLOWED',
  /**
   * Returned by `POST /admin/series/:id/cover/complete` when the uploaded
   * object's real size (`StorageService.headObject`'s `contentLength`) is
   * zero or exceeds `MAX_SERIES_COVER_UPLOAD_BYTES`
   * (`series/series-cover.constants.ts`). `Series.coverImageKey` is left
   * untouched.
   */
  SERIES_COVER_SIZE_OUT_OF_BOUND = 'SERIES_COVER_SIZE_OUT_OF_BOUND',
  // Work unit "SERIES COVER UPLOAD BACKEND CONTRACT" fix cycle 1 (2026-08-15)
  /**
   * Returned by `POST /admin/series/:id/cover/complete` when `key` is a
   * well-formed key for THIS series (passes `isValidSeriesCoverObjectKey`)
   * but matches NEITHER the series' current `pendingCoverImageKey` (the most
   * recently minted, still-in-flight upload intent) NOR its current
   * `coverImageKey` (the idempotent-re-complete case, which is a no-op
   * success, not this error). Closes a reviewer-reproduced HIGH finding: a
   * stale/replayed `complete` call carrying an OLD, already-superseded key —
   * e.g. one from before a legitimate replace, or one minted before an
   * explicit `PATCH { coverImageKey: null }` clear — could previously
   * silently succeed and revert/un-clear `Series.coverImageKey`. Now it is
   * rejected outright: `Series.coverImageKey` is left completely untouched.
   * Deliberately distinct from `SERIES_COVER_KEY_INVALID` (that code means
   * "this key was never a valid shape for this series at all"; this one
   * means "the key IS a real key this series once minted, but it is no
   * longer the current pending or live one").
   */
  SERIES_COVER_KEY_SUPERSEDED = 'SERIES_COVER_KEY_SUPERSEDED',
  // Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION"
  /**
   * Returned (503) by every `/payments/*` surface — checkout, order status,
   * and the Midtrans webhook — while `PAYMENTS_ENABLED` is not the literal
   * string `"true"` (this repo's shipped default). Fail-closed twin of
   * `DEV_TOOLS_DISABLED`, but 503 rather than 404: the payment surface is a
   * real, documented part of the API that is temporarily/deliberately not in
   * service, not a route whose existence is being hidden. For the webhook
   * specifically, 503 also matches Midtrans' documented retry behavior
   * (a 503 is retried), so a notification delivered during a brief
   * flag-off window is not permanently lost.
   */
  PAYMENTS_DISABLED = 'PAYMENTS_DISABLED',
  /**
   * Returned by `POST /payments/checkout` when `planId` is not one of the
   * server-side `PAYMENT_PLANS` catalog ids
   * (`src/payments/payment-plan.constants.ts`). The catalog — never the
   * client — is the ONLY source of price/duration, so an unknown id has
   * nothing it could legitimately resolve to. 404, matching
   * `USER_NOT_FOUND`'s "the referenced thing does not exist" shape.
   */
  PAYMENT_PLAN_NOT_FOUND = 'PAYMENT_PLAN_NOT_FOUND',
  /**
   * Returned by `GET /payments/:orderId` when the id matches no
   * `PaymentOrder` row — OR matches a row owned by a DIFFERENT user.
   * Deliberately the SAME code and status (404) for both, mirroring the
   * anti-enumeration stance `INVALID_CREDENTIALS` documents for auth: a
   * caller probing other users' order ids learns nothing about whether an
   * id exists. Also returned by the Midtrans webhook when a
   * signature-valid notification names an `order_id` this backend never
   * generated (e.g. a transaction created directly from the Midtrans
   * dashboard) — 404 tells Midtrans "not ours", is retried only twice per
   * their documented policy, and transitions nothing.
   */
  PAYMENT_ORDER_NOT_FOUND = 'PAYMENT_ORDER_NOT_FOUND',
  /**
   * Returned (409) by `POST /payments/checkout` when another request for
   * the same user+plan is mid-flight (its order row exists in `CREATED`
   * but the Midtrans Snap create call has not resolved yet, and it is not
   * yet old enough to be reclaimed as abandoned). The caller should simply
   * retry in a moment — at which point the open order is returned
   * idempotently. This is the loser's answer in the `openOrderKey` unique
   * race; it can never create a second chargeable order.
   */
  PAYMENT_CHECKOUT_IN_PROGRESS = 'PAYMENT_CHECKOUT_IN_PROGRESS',
  /**
   * Returned (502) by `POST /payments/checkout` when the Midtrans Snap
   * create call fails (non-2xx, malformed response, or transport error).
   * The internal order row is CAS-failed (`FAILED`,
   * `failureCode: PROVIDER_CREATE_FAILED`) before this is thrown, so a
   * provider outage leaves an auditable dead order — never a half-open one
   * that blocks future checkouts, and never any Premium state. The message
   * carries no provider response body and no request detail (the
   * Authorization header embeds the Server Key).
   */
  PAYMENT_PROVIDER_ERROR = 'PAYMENT_PROVIDER_ERROR',
  /**
   * Returned (400) by the Midtrans webhook when the notification body is
   * not a JSON object carrying the five string fields the verified
   * Midtrans contract requires (`order_id`, `status_code`, `gross_amount`,
   * `signature_key`, `transaction_status`). Purely a SHAPE failure —
   * checked before any signature math or DB lookup. Unknown EXTRA fields
   * are deliberately tolerated (the provider adds fields over time), which
   * is why the webhook takes `unknown` and narrows manually instead of
   * using a whitelisting `ValidationPipe` DTO that would reject them.
   */
  PAYMENT_NOTIFICATION_INVALID = 'PAYMENT_NOTIFICATION_INVALID',
  /**
   * Returned (403) by the Midtrans webhook when the body parses but fails
   * AUTHENTICITY: its `signature_key` does not equal
   * `SHA512(order_id + status_code + gross_amount + ServerKey)` (the
   * verified official formula, compared timing-safely), or its
   * signature-covered `gross_amount` does not equal the order's own
   * server-computed `amountIdr`. Nothing is transitioned and no
   * entitlement is touched. Deliberately ONE code for both causes: a
   * forger probing the endpoint learns only "rejected", not which check
   * tripped.
   */
  PAYMENT_NOTIFICATION_REJECTED = 'PAYMENT_NOTIFICATION_REJECTED',
  // PHASE 10B (production identity providers: email + Google + WhatsApp)
  /**
   * Returned (503) by every Google sign-in/link route when
   * `GOOGLE_AUTH_ENABLED` is not the literal string `"true"`, or when it is
   * but `GOOGLE_OAUTH_CLIENT_IDS` is unset. Mirrors `PAYMENTS_DISABLED`'s
   * shape exactly — a fail-closed "this provider is not configured on this
   * server" answer, never a partial attempt against an unconfigured
   * verifier. Deliberately DISTINCT from `INVALID_GOOGLE_TOKEN`: a caller
   * presenting a perfectly valid token to a server that has no Google
   * client id configured has an operator problem, not a credential
   * problem, and collapsing the two would make that undiagnosable.
   */
  GOOGLE_AUTH_DISABLED = 'GOOGLE_AUTH_DISABLED',
  /**
   * Returned (401) for EVERY way a presented Google ID token can fail
   * server-side verification: malformed/non-JWT input, unknown or missing
   * `kid`, an algorithm other than RS256, a signature that does not verify
   * against Google's published JWKS, an `iss` that is not
   * `accounts.google.com`/`https://accounts.google.com`, an `aud` outside
   * this server's configured client-id allowlist, an `exp` in the past, an
   * `iat`/`nbf` in the future, or a missing `sub`.
   *
   * Deliberately ONE generic code, following the
   * `INVALID_CREDENTIALS`/`INVALID_REFRESH_TOKEN`/`INVALID_ACCESS_TOKEN`
   * precedent this enum already sets: splitting it would tell an attacker
   * probing the endpoint exactly which check to defeat next (e.g.
   * distinguishing "wrong audience" from "expired" reveals that the
   * signature and issuer already passed). The specific cause is recorded in
   * the server-side audit trail instead, never in the response.
   */
  INVALID_GOOGLE_TOKEN = 'INVALID_GOOGLE_TOKEN',
  /**
   * Returned (503) by every WhatsApp OTP route when `WHATSAPP_AUTH_ENABLED`
   * is not the literal string `"true"`. Same fail-closed shape and
   * rationale as `GOOGLE_AUTH_DISABLED`/`PAYMENTS_DISABLED` above.
   */
  WHATSAPP_AUTH_DISABLED = 'WHATSAPP_AUTH_DISABLED',
  /**
   * Returned (400) when a supplied phone number cannot be normalized to
   * E.164 (see `normalizePhoneToE164`). A pure INPUT-SHAPE failure, decided
   * before any database read, so it reveals nothing about which numbers
   * have accounts — the same "shape errors are safe, existence errors are
   * not" split the payments webhook already draws between
   * `PAYMENT_NOTIFICATION_INVALID` (400, shape) and
   * `PAYMENT_ORDER_NOT_FOUND` (404, existence).
   */
  INVALID_PHONE_NUMBER = 'INVALID_PHONE_NUMBER',
  /**
   * Returned (401) by `POST /auth/whatsapp/otp/verify` and
   * `POST /auth/identities/whatsapp/link` for EVERY failing-OTP condition:
   * no challenge exists for the number, the code is wrong, the challenge
   * expired, its attempt budget is exhausted, it was already consumed, or
   * it lost the single-use claim race to a concurrent verify.
   *
   * ONE generic code for all six, for exactly the reason
   * `INVALID_PASSWORD_RESET_TOKEN` documents: distinguishing "wrong code"
   * from "no challenge for this number" would turn this endpoint into a
   * phone-number enumeration oracle, and distinguishing "expired" from
   * "attempts exhausted" would tell an attacker whether their guessing is
   * making progress. Never split it.
   */
  INVALID_OTP = 'INVALID_OTP',
  /**
   * Returned (429) by `POST /auth/whatsapp/otp/request` when this phone
   * number already has a challenge issued inside the resend-cooldown
   * window, or has exhausted its per-number request budget for the rolling
   * window (see `OTP_RESEND_COOLDOWN_MS` / `OTP_MAX_REQUESTS_PER_WINDOW`).
   *
   * This is a PER-NUMBER, database-backed limit that survives restarts and
   * is independent of the per-IP `@Throttle()` on the same route — an
   * attacker rotating IPs still cannot pump messages at one victim's phone,
   * which is the abuse this code exists to stop (every OTP is a real
   * message that costs money and annoys a real person).
   *
   * ACCEPTED, DOCUMENTED TRADEOFF: answering 429 rather than 202 confirms
   * that *somebody* recently requested a code for this number. That is
   * inherent to any cooldown a caller can observe, it says nothing about
   * whether an ACCOUNT exists for the number (a code can be requested for
   * any number at all), and the alternative — silently swallowing the
   * request — would leave a real user retrying against a wall with no way
   * to know they must wait.
   */
  OTP_RESEND_COOLDOWN = 'OTP_RESEND_COOLDOWN',
  /**
   * Returned (409) when a social sign-in proves an identity that is NOT yet
   * linked to any account, but whose verified email matches an EXISTING
   * account's email. NOTHING is created, linked, or signed in.
   *
   * This is the account-takeover boundary of this whole phase, and the
   * reason it is an error rather than a convenience: "the strings match" is
   * not proof of ownership. Auto-attaching a Google identity to an
   * email/password account on a matching email would mean anyone who can
   * obtain a Google token for an address — including via a provider whose
   * email verification this server does not control — inherits an existing
   * Short Drama account, its entitlements, and its payment history.
   *
   * The supported path is explicit and requires proving BOTH sides: sign in
   * to the existing account normally (email + password), then call
   * `POST /auth/identities/google/link` with the Google credential while
   * authenticated. Linking always requires a live Short Drama session; it
   * is never a side effect of a sign-in attempt.
   *
   * ================== KNOWN, ACCEPTED LIMITATION ==================
   *
   * `POST /auth/register` has never verified that the registrant controls
   * the email address they supply (this predates Phase 10B and is unchanged
   * by it), and this backend ships no email delivery at all — even
   * `POST /auth/password-reset/request` only returns a dev-gated token. A
   * person can therefore register `victim@example.com` without owning it,
   * and the real owner of that Google account will subsequently be REFUSED
   * here and told to "sign in with your existing method, then link" — a
   * password they never set.
   *
   * This is an AVAILABILITY / squatting problem, not a takeover: the
   * squatter gains nothing the victim controls, and the victim's Google
   * account is never attached to the squatter's account. The refusal is
   * still the correct behaviour — the alternative (attaching Google to an
   * account whose email was never proven) is the actual takeover this code
   * exists to prevent, so the check must NOT be narrowed to "only collide
   * when the existing email is verified": with no email verification
   * anywhere in this system, that would disable the boundary entirely.
   *
   * The real fix is email-ownership verification at registration, which
   * needs an email-delivery capability this backend does not have and is a
   * separate work unit. Recorded here rather than left for a future reader
   * to rediscover.
   */
  AUTH_ACCOUNT_LINK_REQUIRED = 'AUTH_ACCOUNT_LINK_REQUIRED',
  /**
   * Returned (409) by the link routes when the presented external identity
   * is already bound to a DIFFERENT Short Drama account. Refused rather
   * than transferred: moving an identity between accounts is an account
   * -recovery operation with its own (unbuilt) ownership-proof
   * requirements, not something a link call may do implicitly. Linking the
   * identity a caller has ALREADY linked to their own account is not an
   * error — it is an idempotent success.
   */
  AUTH_IDENTITY_ALREADY_LINKED = 'AUTH_IDENTITY_ALREADY_LINKED',
  /**
   * Returned (409) by the link routes when the caller's account already has
   * an identity for this provider with a DIFFERENT subject (e.g. linking a
   * second, different Google account). Enforced by
   * `AuthIdentity @@unique([userId, provider])` at the database level as
   * well. Every additional identity is an additional independent way into
   * the account, so accumulating them silently is a security decision, not
   * a convenience — unlink the existing one first.
   */
  AUTH_PROVIDER_ALREADY_LINKED = 'AUTH_PROVIDER_ALREADY_LINKED',
  /**
   * Returned (409) by `DELETE /auth/identities/:provider` when removing the
   * named provider would leave the account with NO usable way to sign in —
   * the "do not remove the user's last authentication method" rule.
   *
   * "Usable" is evaluated against real credentials, not row counts: an
   * `email` identity only counts while `User.passwordHash` is non-null
   * (an account that has never had a password cannot log in with one),
   * while `google`/`whatsapp` identities always count. Deliberately
   * DISTINCT from `SESSION_NOT_FOUND`'s "no such thing" 404: the identity
   * exists and belongs to the caller — the removal is refused on policy,
   * and telling them why is what lets them fix it (link another method
   * first).
   */
  AUTH_LAST_IDENTITY = 'AUTH_LAST_IDENTITY',
  /**
   * Returned (404) by `DELETE /auth/identities/:provider` when the
   * authenticated caller has no identity for that provider. Mirrors
   * `SESSION_NOT_FOUND`'s ownership-scoped shape: the lookup is always
   * scoped to the caller's own `userId`, so this can never be used to probe
   * another account's linked providers.
   */
  AUTH_IDENTITY_NOT_FOUND = 'AUTH_IDENTITY_NOT_FOUND',
  // Work unit "REWARDS BACKEND FOUNDATION"
  /**
   * Returned (503) by every `/rewards/*` route while `REWARDS_ENABLED` is
   * off — this repository's shipped default. Mirrors `PAYMENTS_DISABLED`'s
   * shape exactly: a feature that is deliberately dark answers "not
   * available here", not 404 (which would imply the route does not exist and
   * send a client hunting for a different path) and not 403 (which would
   * imply the caller lacks permission and could be fixed by signing in
   * differently).
   */
  REWARDS_DISABLED = 'REWARDS_DISABLED',
  /**
   * Returned (409) when a debit would take the balance below zero — a
   * redemption the caller cannot afford. Carries no balance figure in the
   * message: the client already has the authoritative balance from
   * `GET /rewards/snapshot`, and restating it in an error string invites a
   * client to parse it back out and treat the error as a data source.
   */
  INSUFFICIENT_REWARD_POINTS = 'INSUFFICIENT_REWARD_POINTS',
  /** Returned (404) when the requested redemption offer id is not in the catalog. */
  REWARD_OFFER_NOT_FOUND = 'REWARD_OFFER_NOT_FOUND',
  /**
   * Returned (409) for a catalog offer that exists but is not currently
   * purchasable (`isEnabled: false` — the mobile `COMING_SOON` state).
   * Deliberately DISTINCT from `REWARD_OFFER_NOT_FOUND`: a client showing a
   * coming-soon tile should be told its tile is real but not yet live, not
   * that it is rendering something that does not exist. Enforced
   * server-side, so a client that ignores the flag still cannot buy it.
   */
  REWARD_OFFER_UNAVAILABLE = 'REWARD_OFFER_UNAVAILABLE',
  /**
   * Returned (409) when a client reuses an `idempotencyKey` it previously
   * used for a DIFFERENT action (e.g. the same key for two different
   * offers).
   *
   * This is the one case where replaying the original result would be
   * actively wrong: the caller asked for offer B and the key belongs to
   * offer A, so answering with A's receipt would report a purchase they did
   * not request — and silently charging them for B under A's key would
   * corrupt the idempotency contract in the other direction. Refusing is the
   * only honest outcome, and it is a client bug worth surfacing loudly.
   */
  REWARD_IDEMPOTENCY_KEY_REUSED = 'REWARD_IDEMPOTENCY_KEY_REUSED',
  /**
   * A reward movement was rejected because its point delta is not a usable
   * non-zero integer. Carries TWO statuses, which is deliberate rather than
   * sloppy — the same defect means different things depending on who
   * supplied the number:
   *
   * - **500**, from `RewardsWalletService.appendEntry`. Every real earn/spend
   *   delta is server-computed from `rewards.constants.ts` and is never read
   *   from a request, so a bad one there can only mean a bug in this backend
   *   — not something a caller did wrong or could fix by retrying.
   * - **400**, from the dev-only point grant, whose amount IS caller-supplied.
   *   There the same condition is an ordinary bad request.
   */
  REWARD_LEDGER_INVALID_DELTA = 'REWARD_LEDGER_INVALID_DELTA',
}
