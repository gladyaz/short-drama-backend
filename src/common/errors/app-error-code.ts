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
}
