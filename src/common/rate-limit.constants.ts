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

/**
 * Phase 12, work unit 12C-B1: `POST /users/me/deletion` is an AUTHENTICATED
 * route — like `change-password`/`logout-all`/`sessions`, which deliberately
 * rely on the app-wide default throttler rather than a dedicated override
 * (see `TASK_QUEUE.md`'s Phase 12 follow-ups, item 2) — but this route gets
 * its OWN, much tighter limit instead of following that precedent. The
 * reasoning differs materially: this action is IRREVERSIBLE (DECISIONS.md
 * decision 1 — immediate hard delete, no grace period, no cancellation),
 * so a caller holding a stolen-but-still-valid access token who does not
 * already know the account's password gets far fewer `currentPassword`
 * guesses before being throttled than the 300/60s default would allow,
 * meaningfully raising the cost of the single most destructive action this
 * API exposes. 5 requests per 15 minutes mirrors the persistent
 * account-lockout threshold's own 15-minute window magnitude
 * (`LOCKOUT_WINDOW_MS`/`LOCKOUT_DURATION_MS` in
 * `src/auth/auth.constants.ts`) while staying generous enough for a
 * legitimate user who mistypes their password once or twice during a
 * genuine deletion attempt.
 */
export const ACCOUNT_DELETION_RATE_LIMIT = 5;
export const ACCOUNT_DELETION_RATE_TTL_MS = minutes(15);

/**
 * Phase 12, work unit 12C-B2: `GET /users/me/export` is another AUTHENTICATED
 * route, like `change-password`/`logout-all`/`sessions` (which rely on the
 * app-wide default throttler — see the Phase 12 follow-ups note in
 * `TASK_QUEUE.md`, item 2) and like `POST /users/me/deletion` above (which
 * deliberately does NOT rely on the default). This route gets its own
 * dedicated, moderately tighter override rather than either extreme:
 *
 * - NOT the generous 300/60s default: unlike a typical authenticated GET
 *   (`GET /users/me/interactions`, `GET /users/me/progress`, `GET
 *   /auth/sessions`), a single call here does several extra reads (profile +
 *   interactions + watch progress + entitlements + a batched video-title
 *   lookup) and returns the caller's ENTIRE personal dataset in one response
 *   body. A caller holding a stolen-but-still-valid access token could use
 *   the generous default to harvest that full dataset up to 300 times a
 *   minute with effectively no cost — a materially cheaper exfiltration path
 *   than scraping the individual `/users/me/interactions`/`/users/me/progress`
 *   endpoints separately, and each call is also more expensive for this
 *   server to serve than those single-table reads.
 * - NOT as tight as `ACCOUNT_DELETION_RATE_LIMIT` (5/15min): export is
 *   read-only and fully reversible (unlike deletion, which is permanent by
 *   design per DECISIONS.md decision 1), and a legitimate user may
 *   reasonably want to re-export more than once in a short window (e.g.
 *   retrying after a dropped connection, or trying a second client/viewer
 *   for the downloaded JSON) — an aggressive limit here would punish normal
 *   use of a harmless, non-destructive action.
 *
 * 10 requests per 5 minutes is generous enough for any legitimate
 * re-export/retry pattern while still bounding a stolen-token harvesting
 * loop to a small, fixed number of full-dataset dumps per window.
 */
export const DATA_EXPORT_RATE_LIMIT = 10;
export const DATA_EXPORT_RATE_TTL_MS = minutes(5);

/**
 * Phase 11, work unit 11L-B4: `POST /admin/media` (upload-initiate) is
 * already `JwtAuthGuard + AdminGuard`-protected (unlike every
 * unauthenticated route above), so it does not need login-attempt-style
 * strictness. It still gets its own tighter-than-default override rather
 * than relying on the generous 300/60s default, for two reasons specific to
 * THIS route: (1) each call mints a real, short-lived presigned R2 `PUT`
 * URL — a paid/billable, credential-backed operation on the storage
 * provider side, not a free local computation like most default-throttled
 * routes; (2) a compromised admin session (stolen access token) could
 * otherwise be used to mint an unbounded number of presigned URLs and
 * `draft` rows in a tight loop. The bound is **60 per minute**, not the 10
 * this work unit first tried: 10 turned out to reject legitimate traffic —
 * the admin-media e2e suite exceeded it and started 429-ing, and a real
 * admin ingesting a season one episode at a time would hit the same wall
 * mid-batch. A limit that blocks the normal workflow is a defect, not
 * security. 60/minute (one per second sustained) still bounds a stolen-token
 * abuse loop to a small, fixed number of presigned URLs and `draft` rows per
 * window — and each URL is short-lived and bound to one server-generated
 * key, so the ceiling on damage is junk draft rows, never data access —
 * while leaving batch uploading comfortably unblocked.
 *
 * Two honest limits of this control, recorded rather than overstated
 * (independent review, 2026-08-08): (1) `ThrottlerGuard` here keys on client
 * IP, not on the admin user id, so an attacker rotating source addresses is
 * not bounded by it, while admins sharing one office NAT share a single
 * bucket — a per-user tracker would be the real fix; (2) the presigned PUT
 * carries no signed `ContentLength`, so each minted URL admits a body of any
 * size. "Junk draft rows" is therefore the ceiling on *rows*, not on bytes
 * written into the bucket. Both are follow-ups, not solved here. Same
 * "authenticated but still gets a dedicated tighter override for a
 * specific reason" precedent as `ACCOUNT_DELETION_RATE_LIMIT`/
 * `DATA_EXPORT_RATE_LIMIT` above, not the generic default.
 */
export const ADMIN_MEDIA_UPLOAD_INITIATE_RATE_LIMIT = 60;
export const ADMIN_MEDIA_UPLOAD_INITIATE_RATE_TTL_MS = minutes(1);
