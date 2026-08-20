/**
 * Phase 12, work unit 12A-B3: the server-side allowlist for `AuthAuditEvent`
 * (see DECISIONS.md "Phase 12 ... approved..." entry, decision 6, and the
 * "Additional binding requirements" section — "Audit event metadata is
 * allowlisted, mirroring the existing `AnalyticsEvent.properties` allowlist
 * precedent"). This is the single source of truth for (a) which event names
 * `AuthAuditService.emit` accepts at all (enforced by TypeScript's union
 * type, not runtime validation of a caller-supplied string — every call site
 * is internal, first-party code, unlike `AnalyticsService`'s
 * client-submitted event names) and (b) which metadata keys survive into the
 * database for each event — anything not listed here is stripped before
 * persistence, exactly mirroring `EVENT_PROPERTY_ALLOWLIST` in
 * `analytics.types.ts`.
 *
 * Every value here is intentionally a small, non-sensitive enum-shaped
 * string — never a token, password, raw email, or raw IP. See
 * `AuthAuditService` for the code that enforces this allowlist plus the
 * separate IP-hashing/user-agent-sanitization steps.
 */
export const AUTH_AUDIT_METADATA_ALLOWLIST = {
  /** A login attempt succeeded. No metadata needed. */
  login_success: [],
  /**
   * A login attempt failed (wrong password, or the email did not resolve to
   * any account). `reason` is a fixed, non-sensitive enum — never the
   * attempted email/password. Values: `user_not_found` | `invalid_password`
   * | `credential_superseded` (Auth test-stability slice: the supplied
   * password was correct when the request started, but a concurrent
   * `changePassword`/`confirmPasswordReset` committed a new password before
   * this login could create its session — see `AuthService.login`'s
   * `FOR SHARE` guard). The client-facing response is the identical generic
   * `INVALID_CREDENTIALS` for all three.
   */
  login_failed: ['reason'],
  /**
   * A login attempt was refused because the account is currently within an
   * active lockout window (see `AccountLockoutService`). Kept as its own
   * event name (distinct from `login_failed`) so an operator reviewing the
   * audit log can tell "wrong password" apart from "account already
   * locked" without inferring it from timing.
   */
  account_locked: [],
  /** A new account was created successfully. No metadata needed. */
  register_success: [],
  /**
   * A refresh token that had already been rotated (or was lost a
   * concurrent-rotation race) was presented again — the existing replay/
   * reuse-detection defensive measure in `AuthService.refresh` that revokes
   * every other session for the account. `reason` distinguishes the two
   * code paths that both trigger this event.
   */
  refresh_reuse_detected: ['reason'],
  /**
   * Phase 12, work unit 12B-B1: `POST /auth/change-password` succeeded — the
   * password hash was updated, every OTHER session for the account was
   * revoked, and the current session's own token pair was rotated (see
   * DECISIONS.md "Phase 12 ... approved..." entry, decision 7). No metadata
   * needed.
   *
   * Password-reset invalidation slice: this event ALSO covers the
   * invalidation of every outstanding `PasswordResetToken` for the account,
   * which a successful change now performs in the same transaction. That is
   * deliberately recorded as a side effect of this one event rather than as
   * its own event or a per-token row: the invalidation cannot happen without
   * a successful change (same transaction, rolled back together), and a
   * per-token trail would add noise whose only distinguishing content —
   * how many reset requests the account had outstanding — is exactly what
   * an audit reader does not need and an audit-log leak should not carry.
   */
  change_password_success: [],
  /**
   * `POST /auth/change-password` was refused because the supplied
   * `currentPassword` did not match the account's stored hash. `reason` is a
   * fixed, non-sensitive enum (mirroring `login_failed`'s `reason`) — never
   * the attempted password.
   */
  change_password_failed: ['reason'],
  /**
   * Phase 12, work unit 12B-B2: `POST /auth/logout-all` succeeded — EVERY
   * session for the account was revoked, INCLUDING the one that made this
   * call (see `AuthController.logoutAll`'s doc comment for the frozen
   * "logs out everywhere, including the calling device" contract). No
   * metadata needed.
   */
  logout_all_success: [],
  /**
   * Phase 12, work unit 12B-B2: `DELETE /auth/sessions/:id` revoked a single
   * session the caller owns. No metadata needed — the session id itself is
   * not persisted here (it is not sensitive, but it is also not useful for
   * an operator reviewing this log without cross-referencing the now-gone
   * `Session` row, so it is simply omitted rather than kept "just in case").
   */
  session_revoked: [],
  /**
   * Phase 12, work unit 12B-B3: `POST /auth/password-reset/request` was
   * called. Fires for BOTH outcomes — the email resolved to a real account
   * (a `PasswordResetToken` row was created; no metadata needed, mirroring
   * `login_success`'s no-metadata convention for the "normal" path) and the
   * email did not resolve to any account (`reason: 'user_not_found'`, no
   * `userId` — mirrors `login_failed`'s identical "unresolved email" case
   * exactly). This distinction is internal/operational only: the HTTP
   * response itself is byte-identical either way (this endpoint's frozen
   * anti-enumeration contract), so recording it here does not create a
   * client-visible enumeration surface — it only gives an operator
   * reviewing this log the same "wrong password vs. no such account"
   * visibility `login_failed` already provides.
   */
  password_reset_requested: ['reason'],
  /**
   * `POST /auth/password-reset/confirm` succeeded — the password hash was
   * updated, the token was consumed (single-use), and every session for the
   * account was revoked. No metadata needed.
   */
  password_reset_confirmed: [],
  /**
   * `POST /auth/password-reset/confirm` was refused. `reason` distinguishes
   * the internal cause (`token_not_found` | `already_used` | `expired` |
   * `claim_failed`) for operator visibility. Password-reset invalidation
   * slice: a token killed by a successful `changePassword` reports the
   * EXISTING `already_used` reason (it is `usedAt`-stamped exactly like a
   * consumed one) — deliberately no new `reason` value, since a distinct one
   * would let an operator-facing enum drift into a recovery-state oracle if
   * it ever surfaced — mirroring
   * `change_password_failed`'s/`login_failed`'s existing "generic client
   * response, disambiguated audit reason" precedent. The client-facing
   * error is always the same generic `INVALID_PASSWORD_RESET_TOKEN`
   * regardless of which reason fired.
   */
  password_reset_confirm_failed: ['reason'],
  /**
   * Phase 12, work unit 12C-B1: `POST /users/me/deletion` succeeded — every
   * session was revoked and the `User` row was deleted (cascades removed
   * every other row this account owns; `AnalyticsEvent`'s OTHER rows for the
   * account anonymize via `SetNull` alone, per DECISIONS.md decision 2 — that
   * model has no `ipHash`/`userAgent` column, so nulling `userId` is the
   * whole story. This very table's OTHER rows do NOT anonymize via `SetNull`
   * alone: `SetNull` only nulls `userId`, and this table's `ipHash` is a
   * globally stable, unsalted, unrotated HMAC that would keep a row
   * correlatable to it if left behind — calling that "anonymized" is exactly
   * what DECISIONS.md's 2026-07-30 decision 1 forbids. Work unit **12E-B1**
   * adds an explicit `tx.authAuditEvent.updateMany(...)` scrub, INSIDE this
   * same deletion transaction and BEFORE `tx.user.deleteMany`, that nulls
   * `userId`/`ipHash`/`userAgent`/`metadata` together — see
   * `AuthService.deleteAccount`'s doc comment for the full ordering
   * rationale). Deliberately emitted WITHOUT a `userId` — see
   * `AuthService.deleteAccount`'s doc comment for the full reasoning: the
   * account no longer exists by the time this fires, and a dangling FK
   * reference would be REJECTED outright at insert time, not merely nulled
   * (`onDelete: SetNull` only fires when the REFERENCED row is deleted, not
   * when a new row is inserted pointing at an id that never/no-longer
   * exists). No metadata needed.
   */
  account_deletion_success: [],
  /**
   * `POST /users/me/deletion` was refused. `reason` distinguishes
   * `invalid_current_password` (mirrors `change_password_failed`'s identical
   * reason string exactly) from `role_not_allowed` (DECISIONS.md decision
   * 1's normal-user-only restriction — an `admin`/other privileged account
   * attempted self-service deletion). The account still exists in BOTH
   * cases (the request was refused before anything was touched), so
   * `userId` IS included here, unlike the success event above.
   */
  account_deletion_failed: ['reason'],
  /**
   * Phase 12, work unit 12C-B2: `GET /users/me/export` succeeded — the
   * caller's own personal-data export was assembled and returned. Recorded
   * because a data export is a security-relevant action worth being able to
   * investigate later (e.g. "was this account's data harvested shortly
   * before/after a suspicious login"), even though the action itself is
   * read-only and not destructive. No metadata needed — the response body
   * itself is never logged anywhere (see `ExportService`), so there is
   * nothing non-sensitive left to record beyond "this happened, for this
   * user, at this time," which the row's own `userId`/`createdAt` already
   * capture.
   */
  data_export_success: [],
  /**
   * PHASE 10B: a social/OTP sign-in succeeded and issued the SAME internal
   * access + refresh token pair every email/password login issues.
   * `provider` is a fixed value of the closed `AuthProvider` union
   * (`google` | `whatsapp` — never `email`, which keeps using
   * `login_success`), and `outcome` distinguishes `signed_in` (the identity
   * already existed) from `registered` (a brand-new Short Drama account was
   * created for a genuinely new identity). Both are small non-sensitive
   * enums — never a Google `sub`, never a phone number, never a token.
   */
  identity_login_success: ['provider', 'outcome'],
  /**
   * PHASE 10B: a social/OTP sign-in was refused. `provider` is the same
   * closed enum; `reason` is the INTERNAL cause, which the client never
   * sees — every one of these collapses to a single generic client-facing
   * error (`INVALID_GOOGLE_TOKEN` / `INVALID_OTP`), exactly as
   * `login_failed`'s `reason` disambiguates a response that is always
   * `INVALID_CREDENTIALS`.
   *
   * Google values are `GoogleTokenRejectionReason` (`bad_audience`,
   * `expired`, `bad_signature`, ...). WhatsApp values are
   * `otp_not_found` | `otp_expired` | `otp_wrong_code` |
   * `otp_attempts_exhausted` | `otp_already_used` | `otp_claim_lost`.
   * Every value is a fixed enum string — never the attempted code, never
   * the raw token, never the phone number.
   */
  identity_login_failed: ['provider', 'reason'],
  /**
   * PHASE 10B: a sign-in proved an identity that is not linked to any
   * account, but whose VERIFIED email matches an existing account —
   * refused with `AUTH_ACCOUNT_LINK_REQUIRED`, nothing created or linked.
   *
   * This is the single most security-relevant event this phase adds and is
   * deliberately its own event name rather than an `identity_login_failed`
   * reason: a burst of these against one account is the signature of an
   * attempted provider-collision takeover, and an operator must be able to
   * alert on it without pattern-matching inside a `reason` field. `userId`
   * IS recorded (it is the EXISTING account being targeted, which still
   * exists and is exactly what an investigator needs); the attacker-side
   * identity is not, since a raw Google `sub` is an identifier for a real
   * person at another provider.
   */
  identity_link_required: ['provider'],
  /**
   * PHASE 10B: an authenticated caller successfully linked a new provider
   * to their own account, having proved ownership of it in the same
   * request. `provider` only — never the subject.
   */
  identity_linked: ['provider'],
  /**
   * PHASE 10B: an authenticated caller removed one of their own linked
   * providers. Recorded because losing a way into an account is exactly as
   * security-relevant as gaining one — a silently unlinked provider is
   * indistinguishable from an attacker locking the owner out. `provider`
   * only.
   */
  identity_unlinked: ['provider'],
  /**
   * PHASE 10B: a link or unlink was refused. `reason` is `already_linked`
   * (the identity belongs to another account), `provider_taken` (this
   * account already has a different identity for that provider),
   * `last_identity` (removing it would leave the account with no usable way
   * to sign in), or `not_found`. `provider` accompanies it. The
   * client-facing error IS specific for these (unlike sign-in), because
   * every one of them is only reachable by a caller who has ALREADY
   * authenticated as the account in question — there is no enumeration
   * surface to protect, and a caller who cannot tell why a link failed
   * cannot fix it.
   */
  identity_link_failed: ['provider', 'reason'],
  /**
   * PHASE 10B: `POST /auth/whatsapp/otp/request` was accepted and a
   * challenge row was created. Deliberately carries NO metadata and NO
   * `userId`: at request time the server does not know (and must not
   * record in a way that implies) whether the number belongs to an
   * account, and the phone number itself is never written to the audit
   * trail — `ipHash` is the only correlatable field, exactly as for every
   * other event here.
   */
  otp_requested: [],
  /**
   * PHASE 10B: `POST /auth/whatsapp/otp/request` was refused by the
   * per-NUMBER cooldown or rolling request budget (`OTP_RESEND_COOLDOWN`).
   * `reason` is `cooldown` or `window_exhausted`. Kept as its own event
   * (rather than a failed-login reason) so that OTP-bombing one victim's
   * number is visible to an operator as its own signal.
   */
  otp_request_throttled: ['reason'],
} as const satisfies Record<string, readonly string[]>;

export type AuthAuditEventName = keyof typeof AUTH_AUDIT_METADATA_ALLOWLIST;

export const AUTH_AUDIT_EVENT_NAMES = Object.keys(
  AUTH_AUDIT_METADATA_ALLOWLIST,
) as readonly AuthAuditEventName[];

/** Hard cap applied to every string metadata value before persistence. */
export const MAX_METADATA_STRING_LENGTH = 200;

/**
 * Phase 12, work unit 12B-B2: re-exported from `./auth-crypto.ts` (the
 * single source of truth shared with `Session.userAgent`'s sanitization),
 * not redeclared here — kept as a named export from this file too so
 * existing imports (e.g. `auth-audit.service.spec.ts`) keep working
 * unchanged. See `auth-crypto.ts` for the full rationale.
 */
export { MAX_USER_AGENT_LENGTH } from './auth-crypto';

export type AuthAuditMetadataValue = string | number | boolean;

export interface EmitAuthAuditEventParams {
  /** Omit entirely (not `null`) when no authenticated/resolved user exists yet. */
  userId?: string;
  /** Raw client IP — hashed (HMAC) by `AuthAuditService`, never stored as-is. */
  ip?: string;
  /** Raw `User-Agent` header value — truncated/sanitized by `AuthAuditService`. */
  userAgent?: string;
  /** Only keys listed in `AUTH_AUDIT_METADATA_ALLOWLIST[event]` are persisted. */
  metadata?: Record<string, unknown>;
}
