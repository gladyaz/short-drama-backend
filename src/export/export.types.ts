/**
 * Phase 12, work unit 12C-B2: response shape for `GET /users/me/export`.
 *
 * Binding contract: `DECISIONS.md` "Phase 12 ... approved..." entry, decision
 * 5 — "`GET /users/me/export` is a synchronous, authenticated JSON export of
 * the caller's own data. No `DataExport` storage model, no background job, no
 * expiring cloud link this phase ... The export must exclude internal
 * database IDs, storage paths/keys, roles, password hashes, session/
 * refresh-token hashes or values, any other secret, and any security/audit
 * metadata — it is a personal-data export, not a system dump." Also see the
 * runbook (`.claude/plans/rfc-dag-safe-phase12.md`) frozen per-unit contract
 * for 12C-B2, which additionally names the DATA to include: "profile fields
 * the user actually owns/sees, interactions, watch progress, entitlements."
 *
 * ---
 *
 * ## The central design tension: catalog ids vs. internal ids
 *
 * Decision 5 says exclude "internal database IDs." Taken completely
 * literally, that would also strip `videoId`/`seriesId` out of every
 * interaction/progress entry below, leaving something like "you liked 12
 * things" with no way to tell which 12 — a technically-compliant but
 * genuinely useless personal-data export.
 *
 * The reading applied here, deliberately and explicitly (not by accident):
 * `videoId`/`seriesId` are CATALOG identifiers, not internal/surrogate row
 * ids. They are already:
 *   - returned to and legitimately held by the client on every
 *     `/videos/feed`/`/videos/:id` call (see `VideoResponseDto`), and
 *   - the exact identifiers the mobile app already stores locally for these
 *     same records (`video-interactions.tsx`/`series-progress.tsx`'s
 *     `videoId`/`seriesId` fields, per Phase 9's sync-queue design).
 * Pairing them with the video's human-readable `title` (see `loadVideoTitles`
 * in `export.service.ts`) is what makes "your liked videos" and "your watch
 * progress" sections of this export actually mean something, rather than a
 * list of opaque tokens the reader has no way to resolve.
 *
 * What decision 5 clearly DOES prohibit, and what this file's DTOs never
 * include, is a SURROGATE ROW id — a database primary key that exists purely
 * for the DB's own bookkeeping and carries no meaning to the account holder:
 * `UserVideoInteraction.id`, `WatchProgress.id`, `Entitlement.id`,
 * `Session.id`, `AuthAuditEvent.id`, `PasswordResetToken.id`,
 * `AccountLockout.id`, and — see below — even the account's OWN `User.id`.
 *
 * `User.id` is deliberately excluded even though it is also returned to the
 * client elsewhere (`AuthUserDto.id` on register/login/refresh): unlike
 * `videoId`/`seriesId`, excluding it costs this export nothing — nothing
 * inside the export document needs to reference "which user this beongs to"
 * (the whole document IS that one user's data), so there is no
 * meaningfulness argument for carving out an exception the way there is for
 * catalog ids. Decision 5's literal text ("exclude internal database IDs")
 * is followed without qualification here.
 *
 * ---
 *
 * ## Every model reachable from `User` (`prisma/schema.prisma`), enumerated
 *
 * | Model                  | Decision                                                                 |
 * |-------------------------|--------------------------------------------------------------------------|
 * | `User` (self)           | TRANSFORM — `email`, `displayName`, account-creation date only. Excludes `id` (surrogate, see above), `passwordHash` (a secret — decision 5 names it explicitly), `role` (decision 5 names it explicitly), `updatedAt` (bumped by unrelated internal writes — e.g. a password change — so it is administrative bookkeeping, not meaningful "your data"). |
 * | `Session`               | EXCLUDE ENTIRELY. Every field is session/security metadata — `refreshTokenHash` is a token hash (decision 5 names hashes/tokens explicitly), `ipHash` is security metadata, `userAgent`/`lastUsedAt`/`expiresAt`/`revokedAt`/`id` describe login-device bookkeeping, not personal content. `GET /auth/sessions` already exists as the correct, purpose-built surface for a user to see their own sessions — this export does not duplicate it. |
 * | `AccountLockout`        | EXCLUDE ENTIRELY. Explicitly security metadata (failed-login/lockout bookkeeping) — decision 5 excludes "any ... security metadata" and the work-unit prompt names this model explicitly. Its own existence is not even meaningful to a well-behaved user (a row here only exists after at least one FAILED login). |
 * | `AuthAuditEvent`        | EXCLUDE ENTIRELY. Explicitly named in decision 5 ("any `AuthAuditEvent`/security-metadata field") and in this work unit's contract. This is an operational security log (`AuthAuditService`'s doc comment), not the user's own content. |
 * | `PasswordResetToken`    | EXCLUDE ENTIRELY. Decision 5 excludes "session/refresh-token hashes or values, any other secret" — a reset-token hash is exactly that class of value, and an outstanding/expired reset token carries no meaningful "your data" content for the user to review even if it were stripped to metadata. |
 * | `UserVideoInteraction`  | INCLUDE, TRANSFORMED. Strips `id` (surrogate) and `userId` (redundant — every row here already belongs to the caller); keeps the catalog `videoId` (see the design-tension discussion above), adds a resolved `videoTitle` for meaningfulness, and keeps `isLiked`/`isSaved`/`updatedAt` (this account's own like/save state, exactly what `GET /users/me/interactions` already returns today — see `UserInteractionDto`). |
 * | `WatchProgress`         | INCLUDE, TRANSFORMED. Strips `id`/`userId`; keeps `seriesId` and the catalog `lastWatchedVideoId` (renamed `videoId` for symmetry with the interactions section — same "catalog id, not internal id" reasoning), adds a resolved `videoTitle`, keeps `lastWatchedEpisodeNumber`/`positionSeconds`/`durationSeconds`/`updatedAt` (mirrors `GET /users/me/progress`'s existing `ProgressResponseDto` shape). |
 * | `Entitlement`           | INCLUDE, TRANSFORMED. Strips `id`/`userId`; keeps `tier`/`source`/`grantedAt`/`expiresAt`/`revokedAt` — this account's own premium-entitlement HISTORY (richer than `GET /users/me/entitlement`'s single current-status boolean, appropriate for a personal-data export whose point is completeness of "what happened to my account," not a live authorization check). |
 * | `AnalyticsEvent`        | EXCLUDE. See the dedicated discussion below — this is the one genuinely arguable call in this table. |
 *
 * `Video` itself is not owned by `User` at all (no relation exists in the
 * schema — `videoId`/`lastWatchedVideoId` are plain, FK-less strings, exactly
 * like every other consumer of these two tables already treats them —
 * `InteractionsService`/`ProgressService`). It is joined here ONLY to resolve
 * a human-readable `title` for each referenced catalog id, via an explicit
 * `select: { id: true, title: true }` (see `loadVideoTitles` in
 * `export.service.ts`) — Prisma's `select` means `storageKey`,
 * `objectStorageKey`, `coverImageKey`, `thumbnailImageKey`,
 * `accessTierOverride`, and every other `Video` column are never even
 * fetched into memory for this code path, let alone serialized, so there is
 * no code path by which a storage path/key could leak into this export
 * through the video-title lookup.
 *
 * ---
 *
 * ## `AnalyticsEvent`: argued both ways, decision is EXCLUDE
 *
 * **For inclusion:** `AnalyticsEvent.userId` is a real (if nullable) relation
 * to `User`, so in the broadest sense product-analytics events ARE "the
 * user's data." `AnalyticsEvent.properties` is already validated against a
 * strict per-event server-side allowlist before it is ever persisted
 * (`EVENT_PROPERTY_ALLOWLIST` in `analytics.types.ts` — `feed_view`,
 * `video_play`, `video_like`, `video_save`, `episode_navigate`,
 * `premium_gate_hit`, `app_error`), and the table has no IP/hash column at
 * all — so, unlike `AuthAuditEvent`, nothing here is inherently
 * security-sensitive, and "scrub before including" would already be
 * satisfied by the existing write-time allowlist.
 *
 * **Against inclusion, and the reason this file excludes it:**
 *   1. The frozen contract's own description of what this export contains
 *      — "profile fields ... interactions, watch progress, entitlements" —
 *      is a closed list. It does not say "and analytics," in a runbook that
 *      is otherwise careful to spell out scope explicitly and exhaustively
 *      elsewhere (see decision 5's own itemized exclusion list). Silently
 *      adding a whole extra category beyond what was named risks exactly the
 *      kind of undocumented scope creep this task explicitly warns against.
 *   2. `AnalyticsEvent` is product/crash TELEMETRY about how the app was
 *      used and whether it crashed — its purpose is operational/product
 *      insight, not a record the user themselves created or would recognize
 *      as "my content" (unlike a like, a save, a watch-progress bookmark, or
 *      a purchased entitlement, each of which is a deliberate outcome of the
 *      user's own action). `app_error` events in particular can carry a
 *      truncated stack trace (`stack`, capped at
 *      `MAX_PROPERTY_STRING_LENGTH` = 2000 chars) — internal code-path
 *      detail about THIS APPLICATION, not personal data about the user, and
 *      not something a "your data" export should be surfacing regardless of
 *      how well-scrubbed it already is for its original (crash-diagnostics)
 *      purpose.
 *   3. YAGNI: nothing in this work unit's acceptance criteria or the test
 *      list requires analytics coverage, and the exhaustive-exclusion tests
 *      in `export.e2e-spec.ts` below already prove no `AuthAuditEvent`/
 *      `Session`/hash/secret value leaks — adding analytics would only add
 *      surface area to get wrong for a category the contract never asked
 *      for.
 *
 * This is a judgment call within the frozen contract's stated scope, not a
 * new binding decision that supersedes anything in `DECISIONS.md` — a future
 * work unit could add it back with its own explicit human sign-off if a
 * broader "everything we ever recorded about you" export is ever required.
 */
export interface ExportedProfileDto {
  email: string;
  displayName: string | null;
  /** `User.createdAt`, ISO 8601. When this account was created. */
  memberSince: string;
}

/**
 * One `UserVideoInteraction` row, transformed for export. See the file-level
 * doc comment above for the include/exclude/transform reasoning.
 */
export interface ExportedInteractionDto {
  /** Catalog id (`Video.id`) — see the design-tension discussion above. */
  videoId: string;
  /**
   * Resolved from `Video.title` at export time purely so this entry is
   * meaningful on its own. `null` if the video no longer exists in the
   * catalog (there is no delete-video endpoint yet, so this should not
   * currently happen in practice, but `videoId` has no DB-level FK to
   * `Video` — see `prisma/schema.prisma`'s `UserVideoInteraction` doc
   * comment — so this must be handled, not assumed impossible).
   */
  videoTitle: string | null;
  isLiked: boolean;
  isSaved: boolean;
  /** ISO 8601. When this like/save state was last changed. */
  updatedAt: string;
}

/**
 * One `WatchProgress` row, transformed for export. See the file-level doc
 * comment above for the include/exclude/transform reasoning.
 */
export interface ExportedWatchProgressDto {
  /** Catalog id (`Series.id`/`Video.seriesId`). */
  seriesId: string;
  /** Catalog id (`Video.id`), renamed from `WatchProgress.lastWatchedVideoId`. */
  videoId: string;
  /** Resolved from `Video.title`; `null` under the same conditions as `ExportedInteractionDto.videoTitle`. */
  videoTitle: string | null;
  episodeNumber: number;
  positionSeconds: number;
  durationSeconds?: number;
  /** ISO 8601. When this progress row was last updated. */
  updatedAt: string;
}

/**
 * One `Entitlement` row, transformed for export. See the file-level doc
 * comment above for the include/exclude/transform reasoning.
 */
export interface ExportedEntitlementDto {
  tier: string;
  source: string;
  /** ISO 8601. */
  grantedAt: string;
  /** ISO 8601, or `null` if this entitlement never expires. */
  expiresAt: string | null;
  /** ISO 8601, or `null` if this entitlement has not been revoked. */
  revokedAt: string | null;
}

/** Full response body for `GET /users/me/export`. */
export interface UserExportDto {
  /** ISO 8601. When this export was generated (this call, not a stored artifact — decision 5's "synchronous" requirement). */
  exportedAt: string;
  profile: ExportedProfileDto;
  interactions: ExportedInteractionDto[];
  watchProgress: ExportedWatchProgressDto[];
  entitlements: ExportedEntitlementDto[];
}
