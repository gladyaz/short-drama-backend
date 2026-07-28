import { minutes, seconds } from '@nestjs/throttler';

/**
 * Phase 12, work unit 12A-B1: named-constant IP request-throttle
 * configuration for `ThrottlerModule` (see DECISIONS.md "Phase 12 ...
 * approved..." entry, decision 4). Centralized here (not inline in
 * `app.module.ts`/`auth.controller.ts`) per `common/coding-style.md`
 * ("no hardcoded values" — magic numbers get named constants).
 *
 * This is coarse, in-memory, per-`Nest` application-instance IP throttling
 * — a shared/persistent IP-rate store across multiple backend instances is
 * explicitly deferred to Phase 13 (decision 4). It is a SEPARATE mechanism
 * from the persistent PostgreSQL account-lockout constants in
 * `src/auth/auth.constants.ts`, which survives restarts and is keyed to the
 * account, not the IP.
 */

/**
 * Generous default limit applied to every route that has NOT been given a
 * tighter `@Throttle()` override (i.e. everything except
 * `/auth/login|register|refresh`). Deliberately high enough that no
 * existing/legitimate test or real client traffic pattern in this app comes
 * close to tripping it — it exists purely as coarse abuse protection, not as
 * a meaningful per-route limit (see `LOGIN_RATE_LIMIT`/`REGISTER_RATE_LIMIT`/
 * `REFRESH_RATE_LIMIT` below for the routes that actually need a strict
 * limit).
 */
export const DEFAULT_THROTTLE_LIMIT = 300;
export const DEFAULT_THROTTLE_TTL_MS = seconds(60);

/** `POST /auth/login`: 5 requests per minute per IP (decision 4). */
export const LOGIN_RATE_LIMIT = 5;
export const LOGIN_RATE_TTL_MS = seconds(60);

/** `POST /auth/register`: 3 requests per 10 minutes per IP (decision 4). */
export const REGISTER_RATE_LIMIT = 3;
export const REGISTER_RATE_TTL_MS = minutes(10);

/** `POST /auth/refresh`: 30 requests per minute per IP (decision 4). */
export const REFRESH_RATE_LIMIT = 30;
export const REFRESH_RATE_TTL_MS = seconds(60);

/**
 * Phase 12, work unit 12B-B3: `POST /auth/password-reset/request` is
 * unauthenticated (reachable by anyone, like login/register/refresh above),
 * so it needs its own tight per-route override too — without one it is both
 * a token-generation-spam vector (a `PasswordResetToken` row plus a bcrypt
 * -free HMAC hash per call, cheap but not free) and an enumeration-timing
 * probe. Deliberately set to the SAME 3/10min threshold as
 * `REGISTER_RATE_LIMIT`: both are unauthenticated, low-frequency-legitimate-
 * use, state-changing actions where a genuine caller essentially never needs
 * more than a couple of attempts in a 10-minute window (a real user asking
 * to reset their password twice in 10 minutes is already an edge case), not
 * a distinct new threshold invented for this route alone.
 */
export const PASSWORD_RESET_REQUEST_RATE_LIMIT = 3;
export const PASSWORD_RESET_REQUEST_RATE_TTL_MS = minutes(10);

/**
 * `POST /auth/password-reset/confirm` is also unauthenticated (no access
 * token; a stolen-but-unconsumed reset token is the only credential in
 * play), so it gets the same tight-override treatment. The 256-bit token
 * itself is infeasible to brute-force regardless of any rate limit, but a
 * limit still bounds basic retry/typo abuse and keeps this route consistent
 * with the "every unauthenticated route gets an explicit tight override"
 * precedent the routes above already establish. Set to the SAME 5/min
 * threshold as `LOGIN_RATE_LIMIT`: a real caller pasting/retyping a reset
 * token and new password a handful of times is normal; anything beyond that
 * in one minute is not legitimate traffic.
 */
export const PASSWORD_RESET_CONFIRM_RATE_LIMIT = 5;
export const PASSWORD_RESET_CONFIRM_RATE_TTL_MS = seconds(60);
