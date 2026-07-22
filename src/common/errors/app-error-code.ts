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
}
