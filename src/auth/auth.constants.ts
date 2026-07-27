/**
 * Named constants for Phase 8, work unit 8-B5 (AuthModule). Kept centralized
 * per `common/coding-style.md` ("no hardcoded values" / no magic numbers or
 * inline strings scattered across files).
 */

/**
 * Minimum password length enforced at registration. 8 characters is the
 * commonly recommended floor (NIST SP 800-63B does not mandate a specific
 * minimum beyond "at least 8"); this project does not (yet) enforce
 * complexity rules (uppercase/symbol requirements), preferring length as the
 * dominant factor, consistent with current guidance.
 */
export const MIN_PASSWORD_LENGTH = 8;

/** Defensive upper bound to avoid pathological bcrypt cost on huge inputs. */
export const MAX_PASSWORD_LENGTH = 128;

/**
 * bcrypt cost factor (log2 rounds). 12 is a widely used default that keeps
 * hashing under ~250ms on typical modern hardware while remaining
 * meaningfully slow against offline brute-force, and matches the
 * "10-12" range called out in the work unit spec.
 */
export const BCRYPT_COST_FACTOR = 12;

/** Access token lifetime, per the Phase 8 adopted default (~15 min). */
export const ACCESS_TOKEN_TTL = '15m';

/** Refresh token lifetime, per the Phase 8 adopted default (~30 days). */
export const REFRESH_TOKEN_TTL_DAYS = 30;
export const REFRESH_TOKEN_TTL_MS =
  REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * Number of random bytes used to generate the opaque refresh token
 * (32 bytes = 256 bits of entropy, hex-encoded to 64 characters).
 */
export const REFRESH_TOKEN_BYTES = 32;

/**
 * Precomputed bcrypt hash of a fixed, non-secret dummy password (cost factor
 * matches `BCRYPT_COST_FACTOR`). Used ONLY to run a bcrypt.compare() against
 * *something* when a login's email doesn't match any user, so that a
 * nonexistent-email login and a wrong-password login take a comparable
 * amount of time. This defends against timing-based user enumeration
 * (an attacker measuring response latency to infer whether an email is
 * registered). This is not a real credential and matches no real account.
 */
export const DUMMY_HASH_FOR_TIMING_PARITY =
  '$2b$12$N7tlODmEntCTP6fs4ftUg.LlMkEyHyu.r94/xQvgBVT48bIxb8Djq';

/**
 * Phase 12, work unit 12A-B1: persistent PostgreSQL account-lockout
 * thresholds (see DECISIONS.md "Phase 12 ... approved..." entry, decision
 * 4). An existing account is locked for `LOCKOUT_DURATION_MS` after
 * `LOCKOUT_FAILURE_THRESHOLD` failed login attempts within a rolling
 * `LOCKOUT_WINDOW_MS` window. See `AccountLockoutService` for the full
 * rolling-window/lock logic.
 */
export const LOCKOUT_FAILURE_THRESHOLD = 10;
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
