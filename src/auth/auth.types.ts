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
