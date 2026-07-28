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
   * attempted email/password.
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
