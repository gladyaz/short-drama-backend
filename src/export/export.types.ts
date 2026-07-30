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
 * That list is now one item longer: work unit 12E-B2 (`DECISIONS.md`
 * decision 2, 2026-07-30) adds `AnalyticsEvent` — see the dedicated
 * "`AnalyticsEvent`: INCLUDED per decision 2" section further down this file.
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
 * `AccountLockout.id`, `AnalyticsEvent.id`, and — see below — even the
 * account's OWN `User.id`.
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
 * | `AnalyticsEvent`        | INCLUDE, TRANSFORMED. See the dedicated "`AnalyticsEvent`: INCLUDED per decision 2" discussion below — work unit 12E-B2 reverses 12C-B2's original EXCLUDE call, per an explicit human decision. |
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
 * ## `AnalyticsEvent`: INCLUDED per decision 2 (2026-07-30) — supersedes
 * 12C-B2's original EXCLUDE call
 *
 * 12C-B2 originally excluded `AnalyticsEvent` entirely (see this file's git
 * history), reasoning that it was telemetry *about the app* rather than data
 * the user deliberately created, and flagged the call for human confirmation
 * as `TASK_QUEUE.md` follow-up 10 rather than deciding it unilaterally.
 * `DECISIONS.md`'s 2026-07-30 "Phase 12 decision-resolution remediation
 * slice (12E) approved..." entry, decision 2, resolves it the other way:
 *
 * > - Include the authenticated user's `AnalyticsEvent` records.
 * > - Export only the allowlisted event name, the timestamp, and safe
 * >   (allowlisted) properties.
 * > - Exclude internal IDs, IP/device identifiers, roles, security metadata,
 * >   hashes, tokens, storage paths, and secrets.
 *
 * Work unit 12E-B2 implements this. Per row:
 *
 * - **`eventName`** — already restricted at ingestion to
 *   `EVENT_PROPERTY_ALLOWLIST`'s keys (`AnalyticsEventInputDto`'s
 *   `@IsIn(KNOWN_EVENT_NAMES)`), so no additional filtering is needed here.
 * - **`properties`** — re-filtered against `EVENT_PROPERTY_ALLOWLIST` AT READ
 *   TIME, via `filterEventPropertiesForExport` (`analytics.types.ts`), not
 *   merely trusted from `AnalyticsService.sanitizeProperties`'s write-time
 *   scrub. This is DEFENCE IN DEPTH, required by this work unit, not
 *   optional: the write-time scrub only reflects the allowlist as it existed
 *   when a given row was inserted — it cannot retroactively fix a row
 *   written under a past or future version of `EVENT_PROPERTY_ALLOWLIST` (a
 *   key added, renamed, or removed for a given `eventName`). Re-deriving the
 *   filter from the CURRENT allowlist on every read closes that gap
 *   regardless of a row's age.
 * - **`platform`** and **`timestamp`** — see the two dedicated judgment-call
 *   discussions immediately below; both are include/exclude and
 *   which-column calls decision 2 leaves to the implementer, and both are
 *   recorded here deliberately rather than decided silently.
 *
 * Excluded: `id` and `userId` — the same surrogate-id/redundant-owner
 * reasoning as every other section of this file (see "the central design
 * tension" above). There is no catalog-id argument here the way there is for
 * `videoId`/`seriesId` elsewhere in this export — `AnalyticsEvent` does not
 * reference the catalog at the model level at all; where a `videoId`/
 * `seriesId` key legitimately appears INSIDE `properties` (e.g. `video_play`,
 * `episode_navigate`), it passes through unchanged, on the same "catalog id,
 * not internal id" reasoning already applied to the interactions/progress
 * sections above. `clientTimestamp` is also excluded — see the timestamp
 * discussion below.
 *
 * ### Judgment call 1 of 2: `platform` is INCLUDED
 *
 * `AnalyticsEvent.platform` holds exactly one of `'ios'`/`'android'`/`'web'`
 * (`KNOWN_PLATFORMS`) — a coarse, three-valued category describing which
 * client app sent the event, not a value that narrows down to a specific
 * device or person. Decision 2 excludes "IP/device identifiers"; this is
 * deliberately read as NOT reaching `platform`:
 *
 *   1. An "identifier" (IP address, device ID, advertising ID, hardware
 *      fingerprint) is, by construction, chosen to be as unique as possible
 *      per device/installation — that is the whole point of an identifier.
 *      `platform` is the opposite: exactly 3 possible values shared across
 *      every user on that platform, no narrower than "this happened on an
 *      iOS/Android/web client" — the same order of specificity as `source`
 *      (already an allowlisted, exported `properties` value for
 *      `episode_navigate`/`premium_gate_hit`) or `isFatal` for `app_error`.
 *   2. This codebase already excludes the genuinely device/security-
 *      identifying fields elsewhere, by excluding the whole model they live
 *      on: `Session.userAgent`/`Session.ipHash` are kept out of this export
 *      by excluding `Session` ENTIRELY (see that row in the model table
 *      above) — real per-installation/per-connection strings, not a 3-way
 *      enum. `platform` was never grouped with them; it lives on a different
 *      model, for a different (product-analytics, not security-audit)
 *      purpose.
 *   3. Including it costs nothing and adds real meaning, matching this
 *      file's existing precedent of keeping meaningful-but-technically-
 *      excludable context (`videoId`/`seriesId` for interactions/progress)
 *      over a maximally literal reading that strips a value with no
 *      realistic re-identification risk — "this `app_error` happened on my
 *      Android app" is closer to a faithful "your data" record than omitting
 *      it.
 *
 * ### Judgment call 2 of 2: `timestamp` is `receivedAt`, not `clientTimestamp`
 *
 * `AnalyticsEvent` carries two timestamps: `clientTimestamp` (caller-supplied
 * in the ingestion request body, validated only for ISO-8601 SHAPE —
 * `@IsISO8601()` — never for plausibility against server time) and
 * `receivedAt` (`@default(now())`, stamped by Postgres/Prisma at insert
 * time, never client-influenced). This export uses `receivedAt`, exposed as
 * `timestamp`, for two independent reasons:
 *
 *   1. **Truthfulness.** `clientTimestamp` is attacker-influencable — any
 *      caller can send an arbitrary past or future ISO-8601 string and it is
 *      persisted verbatim (`AnalyticsService.ingest` only re-validates that
 *      it PARSES, not that it is close to real time). A personal-data
 *      export's job is to state what actually happened, as the SERVER
 *      recorded it — `receivedAt` is the one value in this row nothing on
 *      the client side can forge.
 *   2. **Consistency with how this codebase already treats the same
 *      column.** `RetentionService.processAnalyticsEvents`
 *      (`retention.service.ts`) already filters and computes its cutoff on
 *      `receivedAt`, explicitly not `clientTimestamp`, for the identical
 *      reason. Exporting `clientTimestamp` here would mean the export and
 *      the retention job disagree about which instant is authoritative for
 *      the same row.
 *
 * `clientTimestamp` itself is not exported at all — there is no legitimate
 * "your data" reason to surface a value that is, by construction, not
 * guaranteed to be true.
 *
 * ### Size and pagination: no cap added, and why that is the honest answer
 *
 * Decision 2 does not authorize truncating a user's data, and this file does
 * not add one. But this addition is flagged, honestly, as the one part of
 * this export whose SIZE CHARACTERISTICS actually change materially, unlike
 * the other three sections:
 *
 *   - `interactions`/`watchProgress` are bounded by catalog size (one row
 *     per video/series a user has ever touched) and `entitlements` by admin/
 *     dev-grant actions — none is user-request-driven growth.
 *   - `AnalyticsEvent` is the opposite: the ingestion endpoint accepts up to
 *     `MAX_BATCH_SIZE` (50) events per call with no documented cap on how
 *     often a legitimate, actively-used client can call it, and a single
 *     engaged session can plausibly emit a `feed_view` on focus plus a
 *     `video_play`/`episode_navigate`/`premium_gate_hit` per video watched —
 *     by a wide margin the highest-volume table this backend writes to per
 *     active user. `ANALYTICS_EVENT_RETENTION_DAYS` (`retention.constants.ts`)
 *     bounds this in principle, but that job is DRY-RUN AND UNSCHEDULED
 *     (12D-B1/12E-B3) — nothing in this codebase today actually deletes an
 *     old `AnalyticsEvent` row, so a long-lived, highly-engaged account's
 *     analytics history can, in practice, accumulate without limit for as
 *     long as this product exists.
 *   - This is the scenario `TASK_QUEUE.md` follow-up 11 (from 12C-B2's
 *     review) flagged as "worth revisiting if catalog scale grows by orders
 *     of magnitude" — except here the growth axis is TIME AND ENGAGEMENT,
 *     not catalog size, and it is already live today, not speculative. A
 *     synchronous, unbounded export of this table for a years-old,
 *     daily-active account could become a genuinely large response
 *     (thousands to tens of thousands of rows) well before the other three
 *     sections would.
 *
 * Given decision 2's explicit text (an include list plus a named exclusion
 * list, with no size/pagination carve-out) and decision 5's earlier, still-
 * binding scope note that pagination is out of scope this phase, the correct
 * move is to report this honestly rather than silently invent a cap decision
 * 2 never authorized. No cap, offset, or truncation is added here. Rows are
 * ordered `receivedAt: 'desc'` (newest first — mirrors `entitlements`'
 * existing `grantedAt: 'desc'` choice, on the reasoning that the most RECENT
 * activity is the most likely to be relevant to a user reviewing their own
 * data), so if a future work unit does add a cap or pagination, "the most
 * recent N" is already the natural default to keep.
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

/**
 * One `AnalyticsEvent` row, transformed for export (Phase 12, work unit
 * 12E-B2 — `DECISIONS.md` decision 2, 2026-07-30). See the file-level doc
 * comment's dedicated `AnalyticsEvent` section above for the full include/
 * exclude/transform reasoning, and specifically the two named judgment
 * calls (`platform` included; `timestamp` is `receivedAt`, not
 * `clientTimestamp`).
 */
export interface ExportedAnalyticsEventDto {
  /** One of `EVENT_PROPERTY_ALLOWLIST`'s keys (`analytics.types.ts`). */
  eventName: string;
  /** ISO 8601. `AnalyticsEvent.receivedAt` — see the timestamp judgment-call discussion above for why NOT `clientTimestamp`. */
  timestamp: string;
  /** `'ios' | 'android' | 'web'` — see the platform judgment-call discussion above for why this coarse category is included. */
  platform: string;
  /**
   * Re-filtered against the CURRENT `EVENT_PROPERTY_ALLOWLIST` at read time
   * (`filterEventPropertiesForExport`, `analytics.types.ts`) — defence in
   * depth, not merely a pass-through of the write-time-scrubbed column. May
   * be an empty object for events with no allowlisted properties (e.g.
   * `feed_view`).
   */
  properties: Record<string, string | number | boolean>;
}

/** Full response body for `GET /users/me/export`. */
export interface UserExportDto {
  /** ISO 8601. When this export was generated (this call, not a stored artifact — decision 5's "synchronous" requirement). */
  exportedAt: string;
  profile: ExportedProfileDto;
  interactions: ExportedInteractionDto[];
  watchProgress: ExportedWatchProgressDto[];
  entitlements: ExportedEntitlementDto[];
  /** This account's own `AnalyticsEvent` history. See the file-level doc comment's `AnalyticsEvent` section for why this is unbounded and ordered newest-first. */
  analyticsEvents: ExportedAnalyticsEventDto[];
}
