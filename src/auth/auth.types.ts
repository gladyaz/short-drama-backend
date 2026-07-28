export interface AuthUserDto {
  id: string;
  email: string;
  displayName?: string;
}

export interface AuthResponseDto {
  user: AuthUserDto;
  /** Short-lived JWT (~15 min). Payload contains only `sub` (user id). */
  accessToken: string;
  /**
   * Opaque, cryptographically random, high-entropy string. Only the
   * (keyed) hash of this value is ever persisted server-side (`Session
   * .refreshTokenHash`) — this plaintext value is returned to the client
   * exactly once, at issuance/rotation time, and never logged.
   */
  refreshToken: string;
}

/**
 * Phase 12, work unit 12A-B3: the caller-supplied (controller-layer) request
 * context threaded through `AuthService`'s auth-flow methods purely so they
 * can pass it to `AuthAuditService.emit` — never used for any authorization
 * decision. Both fields are RAW input (the real client IP / the real
 * `User-Agent` header value); `AuthAuditService` is solely responsible for
 * hashing/truncating/sanitizing them before anything is persisted.
 * Optional: unit tests that call `AuthService` methods directly (without an
 * HTTP request) simply omit it, and every `AuthAuditService.emit` field it
 * feeds is itself optional.
 */
export interface AuthRequestContext {
  ip?: string;
  userAgent?: string;
}

/**
 * Phase 12, work unit 12B-B2: `GET /auth/sessions`'s per-session response
 * shape (DECISIONS.md "Phase 12 ... approved..." entry, decision 6).
 * Deliberately just the fields a "manage your logged-in devices" UI needs —
 * NEVER `refreshTokenHash`, NEVER `ipHash`, NEVER `userId`, and never any
 * other hash/secret. `userAgent`/`lastUsedAt` are nullable because the
 * underlying `Session` columns are additive/nullable (a session created
 * before this work unit, or one created without request-context info, has
 * neither).
 */
export interface SessionSummaryDto {
  id: string;
  userAgent: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  expiresAt: string;
}

/**
 * Phase 12, work unit 12B-B3: `POST /auth/password-reset/request`'s
 * response shape (DECISIONS.md "Phase 12 ... approved..." entry, decision
 * 3). `success` is always `true` — this route always responds `202`
 * regardless of whether the email resolved to a real account (the frozen
 * anti-enumeration contract). `devToken` is the ONLY field that can differ
 * between callers, and only when `DEV_TOOLS_ENABLED=true && NODE_ENV !=
 * production` (`AuthService.requestPasswordReset` decides this — never a
 * route guard; see that method's doc comment for why): present (the raw,
 * one-time reset token) when a token was actually created for a resolved
 * account, `undefined`/omitted otherwise (no account resolved, OR dev-token
 * exposure is off). Never a hash, never a password, never any other secret.
 */
export interface PasswordResetRequestResponseDto {
  success: true;
  devToken?: string;
}
