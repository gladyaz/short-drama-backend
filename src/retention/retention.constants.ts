/**
 * Phase 12, work unit 12D-B1: retention/cleanup windows (see
 * `phases/phase-12.md` "12D — Privacy, retention & review sweep" and
 * `TASK_QUEUE.md`'s 12D-B1 row in the control workspace).
 *
 * **Phase 12, work unit 12E-B3 (`DECISIONS.md` "Phase 12 decision-resolution
 * remediation slice (12E) approved..." entry, decision 3, 2026-07-30):** the
 * four windows below other than `WATCH_PROGRESS_RETENTION_DAYS` are now
 * HUMAN-DECIDED values, not engineering defaults:
 *
 * | Data                                    | Retention |
 * |------------------------------------------|-----------|
 * | Expired/revoked session records           | 90 days   |
 * | Password-reset records                    | 90 days   |
 * | Product analytics events                  | 180 days  |
 * | Authentication/security audit events      | 730 days  |
 *
 * Each constant's doc comment below reflects this — the reasoning is now
 * "this is what the human decided, and here is why that reading maps onto
 * this specific model/column," not an implementer's own engineering
 * trade-off presented as if it alone drove the number. Retention execution
 * itself remains dry-run and unscheduled — real scheduling is explicitly
 * deferred to Phase 13 and is NOT authorized by this work unit (decision 3's
 * own text). `WATCH_PROGRESS_RETENTION_DAYS` is the one target decision 3
 * does not mention; it is deliberately left untouched by 12E-B3 (see that
 * constant's own doc comment, unchanged since 12D-B1).
 *
 * This work unit deliberately keeps `AuthAuditEvent` (security/audit) and
 * `AnalyticsEvent` (product telemetry) on SEPARATE, independently-configurable
 * retention windows — they are different models with different purposes (see
 * their own schema doc comments), and giving them one shared TTL would erase
 * that distinction. Each constant below documents why its specific number was
 * chosen, not just what it is.
 *
 * **Binding bound inherited from 12D-B0 (`Session.revokedAt` timezone fix,
 * commit `642a3af`, TASK_QUEUE.md follow-up item 4):** `Session.revokedAt`
 * is one-directionally skewed up to +7 hours for any row REVOKED VIA
 * `AuthService.changePassword` before that commit — `changePassword` was the
 * only call site that ever wrote `revokedAt` via raw `$queryRaw` SQL with no
 * `AT TIME ZONE 'UTC'` conversion, and Postgres silently reinterpreted the
 * bound `timestamptz` parameter using this server's `Asia/Jakarta` (UTC+7,
 * no DST) session `TimeZone`, storing a value that reads UP TO 7 HOURS LATER
 * than the true revocation instant. Every OTHER writer of `Session.revokedAt`
 * (`refresh()`, `logoutAll()`, `revokeSession()`, `deleteAccount()`,
 * `confirmPasswordReset()`) uses Prisma's typed ORM (`updateMany`/`update`
 * with a JS `Date`), which is NOT affected — and `changePassword` itself is
 * fixed from commit `642a3af` onward. Affected rows are NOT distinguishable
 * from correct ones after the fact (no `revokedBy`/`revokedReason` column,
 * and 12D-B0 deliberately did not backfill — a blanket correction would
 * corrupt the correct rows), so `RetentionService` cannot special-case them
 * and must instead treat the skew as universally possible for ANY row whose
 * `revokedAt` it reads.
 *
 * Because the skew is structurally guaranteed to be ONE-DIRECTIONAL (a
 * stored value can only read LATER than reality, never earlier — Jakarta
 * observes no DST, so the offset is a fixed +7h, not a wall-clock-dependent
 * one that could ever go negative), a retention window measured and compared
 * at DAY granularity (via `dayGranularityCutoff` in `retention.util.ts`) is
 * safe: the worst case is that an affected row is purged up to ~7 hours
 * LATER than an hour-precise policy would have purged it (it looks up to 7h
 * "younger" than it really is, so it survives a LITTLE past the nominal
 * cutoff) — it is never purged EARLIER than intended, and for a
 * multi-day/multi-month window a 7-hour rounding error changes nothing
 * observable. This is why every window below is expressed in whole DAYS, and
 * every cutoff in `RetentionService` is computed via day-level truncation,
 * not raw millisecond arithmetic — a future maintainer must not "tighten"
 * these to hour precision without redoing this analysis, which is why this
 * reasoning is written here, not just in a commit message.
 */

/**
 * `Session` rows: covers BOTH a session that was explicitly revoked
 * (`revokedAt` non-null — logout, logout-all, change-password, password
 * reset, refresh-token-reuse defensive revoke, or account deletion, though
 * the last of those actually cascades the whole row away, not merely
 * revokes it) and a session whose refresh token simply expired with age
 * (`expiresAt` in the past) without ever being explicitly revoked.
 *
 * "Stale" here means: this row can never again be used to authenticate
 * (`AuthService.refresh` rejects both a revoked and an expired session), and
 * it is not consumed by any read path that lists PAST sessions —
 * `GET /auth/sessions` (`AuthService.listSessions`) filters to
 * `revokedAt: null` only, by design; there is no "session history" UI or
 * endpoint anywhere in this codebase. Its only remaining latent value is
 * forensic (e.g. correlating `ipHash`/`userAgent`/`lastUsedAt` against an
 * `AuthAuditEvent` investigation opened shortly after the fact).
 * `Session.expiresAt` is ALWAYS written by Prisma's typed ORM at
 * session-creation time (`issueTokensAndSession`) — never by the buggy raw
 * SQL — so it carries no timezone-skew risk at all; it is included in this
 * same window purely because "a dead session" is a dead session regardless
 * of which field proves it, not because it shares `revokedAt`'s bug.
 *
 * **90 days is a human-decided value** (`DECISIONS.md` decision 3,
 * 2026-07-30, "Expired/revoked session records" — work unit 12E-B3,
 * superseding this constant's original 12D-B1 engineering default of 30).
 * The original 30-day engineering rationale (generous enough for a realistic
 * "we noticed something odd a few weeks ago" investigation, without letting
 * this operational table grow forever) still describes the SHAPE of the
 * trade-off; the human's 90-day figure is simply a more conservative point
 * on the same axis, and is the number that governs execution now.
 */
export const SESSION_RETENTION_DAYS = 90;

/**
 * `PasswordResetToken` rows: `POST /auth/password-reset/request` /
 * `POST /auth/password-reset/confirm`'s single-use reset tokens (see
 * `prisma/schema.prisma`'s `PasswordResetToken` doc comment). Mirrors
 * `Session`'s own "explicit end OR natural expiry" shape immediately above,
 * on the same two columns' semantic pairing:
 *   - `usedAt` (non-null) — the token was successfully consumed by
 *     `confirmPasswordReset` and can never be used again. This is the
 *     "revoked" half of decision 3's framing ("expired/revoked password-reset
 *     records") — a used token is functionally dead the same way an
 *     explicitly revoked `Session` is, even though this column is named
 *     `usedAt`, not `revokedAt`.
 *   - `expiresAt` — the token's own TTL (see `AuthService`'s
 *     password-reset flow) elapsed without ever being used. This is the
 *     "expired" half.
 * A row satisfying NEITHER is still a live, outstanding reset token and must
 * never be touched by this job — mirrors `Session`'s "an active session is
 * never touched" property exactly, and is proven by
 * `retention.integration.spec.ts`.
 *
 * **90 days is a human-decided value** (`DECISIONS.md` decision 3,
 * 2026-07-30, "Password-reset records" — work unit 12E-B3). This is a NEW
 * retention target: `PasswordResetToken` was not a retention target at all
 * before 12E-B3 (12D-B1's original five targets were `Session`,
 * `AuthAuditEvent`, `AnalyticsEvent`, `WatchProgress`, and deleted-account
 * residue). Chosen equal to `SESSION_RETENTION_DAYS` above, not by
 * coincidence — decision 3's table lists both at 90 days, and both models
 * play the identical "used-or-expired credential/token bookkeeping, no
 * remaining live purpose, retained only for a bounded forensic window" role
 * in this schema.
 */
export const PASSWORD_RESET_TOKEN_RETENTION_DAYS = 90;

/**
 * `AuthAuditEvent` rows: the operational SECURITY audit trail (login/logout/
 * lockout/refresh-reuse/change-password/reset/deletion/export events — see
 * `auth-audit.types.ts`'s allowlist). "Stale" here means old enough that a
 * realistic security investigation (an account-takeover report, a support
 * ticket, an internal review) would no longer plausibly need it — these
 * investigations can surface weeks after the fact, and the value of this
 * table is specifically its ability to answer "what security-relevant things
 * happened to this account, and when," so the window here is intentionally
 * LONGER than `AnalyticsEvent`'s below: security audit logs are lower-volume
 * (one row per meaningful auth event, not one per UI interaction) and higher
 * evidentiary value per row than product telemetry. Applies UNIFORMLY
 * regardless of whether `userId` is null (anonymized, post-deletion —
 * decision 2/12E-B1) or not: an anonymized row does not need a SHORTER life
 * than an identified one (there is nothing extra-sensitive left to minimize
 * once anonymized), and it must not get a LONGER one either — this is the
 * mechanism, not a special case, by which anonymized rows eventually age out
 * like any other row (see `RetentionService.processAuthAuditEvents`, which
 * never filters on `userId`).
 *
 * **730 days is a human-decided value** (`DECISIONS.md` decision 3,
 * 2026-07-30, "Authentication/security audit events" — work unit 12E-B3,
 * superseding this constant's original 12D-B1 engineering default of 180).
 * At two years, this is now the LONGEST window in this file (WatchProgress's
 * unchanged 730 aside — see that constant's own doc comment, which arrived
 * at the identical number independently, for different reasons, and is not
 * itself part of decision 3) — a deliberately conservative floor for the
 * one table whose entire purpose is answering "what security-relevant thing
 * happened to this account, and when" for as long as a slow-to-surface
 * investigation could plausibly need it.
 */
export const AUTH_AUDIT_EVENT_RETENTION_DAYS = 730;

/**
 * `AnalyticsEvent` rows: product telemetry (`feed_view`/`video_play`/
 * `video_like`/etc. — see `analytics.types.ts`'s allowlist), deliberately
 * kept on a SEPARATE, SHORTER window than `AuthAuditEvent` above (per this
 * work unit's binding requirement that the two models stay independently
 * configurable, not sharing one TTL). "Stale" here means old enough that its
 * product value (recent engagement trends, near-term A/B-style comparisons)
 * has already been realized — this codebase has no analytics
 * warehouse/rollup/aggregation pipeline downstream of this table, so nothing
 * reads an `AnalyticsEvent` older than a few months for any current product
 * purpose. This table is also meaningfully higher-volume per user than
 * `AuthAuditEvent` (many events per session, not one per auth action; see
 * `export.types.ts`'s `AnalyticsEvent` size-assessment discussion for how
 * high-volume in practice), so a shorter window bounds growth more
 * aggressively where the marginal value per row decays faster. Applies
 * UNIFORMLY regardless of `userId` null-ness, for the same reason as
 * `AuthAuditEvent` above — see `RetentionService.processAnalyticsEvents`.
 *
 * **180 days is a human-decided value** (`DECISIONS.md` decision 3,
 * 2026-07-30, "Product analytics events" — work unit 12E-B3, superseding
 * this constant's original 12D-B1 engineering default of 90). Doubling the
 * original figure still leaves this the SHORTEST TTL window in this file
 * (`AnalyticsEvent` 180 < `AuthAuditEvent` 730 = `WatchProgress` 730,
 * coincidentally equal at the top end, for unrelated reasons — see each
 * constant's own doc comment) — the human's absolute numbers changed, the
 * shape of the trade-off between the tables did not.
 */
export const ANALYTICS_EVENT_RETENTION_DAYS = 180;

/**
 * `WatchProgress` rows: per-`(userId, seriesId)` "resume where I left off"
 * state — the ONE target in this file that is genuinely user-VISIBLE data,
 * not backend bookkeeping/exhaust. Deleting a row here is not neutral the
 * way pruning an old audit/analytics event is: the next time that user opens
 * that series, playback silently restarts from the beginning instead of
 * resuming, which is a real, noticeable product regression for that person,
 * not merely freed disk space. This table is also NOT unbounded/attacker-
 * driven growth the way `AnalyticsEvent` is (`interactions.service.ts`'s
 * `@@unique([userId, seriesId])` caps it at one row per user per series
 * ever watched — growth is bounded by `active users x catalog size`, not by
 * request volume), so there is no real storage-pressure argument for an
 * aggressive window here the way there is for the two event-log tables
 * above. Given that asymmetry (real user-facing cost to delete early, no
 * significant benefit to deleting soon), this window is deliberately the
 * MOST conservative of the four: 730 days (2 years) — long enough that, in
 * this product's current lifetime, it is not expected to ever actually
 * trigger a real deletion; it exists so the job is still principled and
 * bounded rather than "watch progress lives forever, full stop," while
 * erring hard on the side of preserving a real person's resume position.
 * This number is a deliberately conservative ENGINEERING default, not a
 * product/UX decision about how long "abandoned" should mean — a human
 * product owner may reasonably want a different number once real usage
 * data exists; see this work unit's report for that call-out.
 */
export const WATCH_PROGRESS_RETENTION_DAYS = 730;
