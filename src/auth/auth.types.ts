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
