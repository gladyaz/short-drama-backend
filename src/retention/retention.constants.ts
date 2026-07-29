/**
 * Phase 12, work unit 12D-B1: retention/cleanup windows (see
 * `phases/phase-12.md` "12D — Privacy, retention & review sweep" and
 * `TASK_QUEUE.md`'s 12D-B1 row in the control workspace).
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
 * `AuthAuditEvent` investigation opened shortly after the fact), which is
 * exactly why the window below is generous enough to cover a realistic
 * "we noticed something odd a few weeks ago" investigation without also
 * letting this operational table grow forever. `Session.expiresAt` is
 * ALWAYS written by Prisma's typed ORM at session-creation time
 * (`issueTokensAndSession`) — never by the buggy raw SQL — so it carries no
 * timezone-skew risk at all; it is included in this same window purely
 * because "a dead session" is a dead session regardless of which field
 * proves it, not because it shares `revokedAt`'s bug.
 */
export const SESSION_RETENTION_DAYS = 30;

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
 * evidentiary value per row than product telemetry. 180 days (~6 months) is
 * a common industry floor for security/audit-log retention outside of a
 * formal compliance regime (which this product is not yet subject to) —
 * long enough to support a slow-to-surface investigation, short enough to
 * still bound table growth and the amount of `ipHash`/`userAgent` data kept
 * about any one account indefinitely. Applies UNIFORMLY regardless of
 * whether `userId` is null (anonymized, post-deletion — decision 2) or not:
 * an anonymized row does not need a SHORTER life than an identified one
 * (there is nothing extra-sensitive left to minimize once anonymized), and
 * it must not get a LONGER one either — this is the mechanism, not a special
 * case, by which decision-2 rows eventually age out like any other row (see
 * `RetentionService.processAuthAuditEvents`, which never filters on
 * `userId`).
 */
export const AUTH_AUDIT_EVENT_RETENTION_DAYS = 180;

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
 * purpose. 90 days (~3 months) is a common default retention window for raw
 * product-analytics events in products without a dedicated long-term
 * warehouse, and this table is also meaningfully higher-volume per user than
 * `AuthAuditEvent` (many events per session, not one per auth action), so a
 * shorter window bounds growth more aggressively where the marginal value
 * per row decays faster. Applies UNIFORMLY regardless of `userId`
 * null-ness, for the same reason as `AuthAuditEvent` above — see
 * `RetentionService.processAnalyticsEvents`.
 */
export const ANALYTICS_EVENT_RETENTION_DAYS = 90;

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
