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

/**
 * Phase 11, work unit 11M-B3 (independent review addendum, 2026-08-08):
 * `GET /videos/:id/playback` mints, for R2-backed media, a presigned GET URL
 * that is (a) directly shareable — no `Authorization` header is checked
 * against it, that is the whole point of the presign — and (b) live for
 * `PLAYBACK_URL_EXPIRY_SECONDS` (15 minutes) once minted, regardless of
 * whether the caller keeps using it. Left on the generous app-wide
 * `DEFAULT_THROTTLE_LIMIT` (300/60s), one authenticated free-tier account
 * could mint ~300 of these per minute, each independently valid for 15
 * minutes — roughly 4,500 concurrently-live, auth-free, directly-shareable
 * URLs per caller at steady state. That is the exact `ADMIN_MEDIA_UPLOAD_
 * INITIATE_RATE_LIMIT` rationale (a route that mints real, credential-backed
 * presigned URLs must not inherit the "cheap local computation" default)
 * applied to a GET-minting route instead of a PUT-minting one, so this gets
 * the same treatment rather than a bespoke one.
 *
 * Set to the SAME 60/minute as `ADMIN_MEDIA_UPLOAD_INITIATE_RATE_LIMIT`, not
 * a stricter number: this route is reachable by every authenticated user
 * (not just admins) and legitimate short-episode-feed usage can call it
 * fairly often — starting an episode, resuming after a pause/backgrounding,
 * or swiping through several short (a few minutes each) episodes in one
 * session. 60/minute (one per second sustained) comfortably covers that
 * while bounding a stolen-token harvesting loop to at most ~900
 * concurrently-live URLs per caller at steady state (60 × 15 min) instead of
 * ~4,500 — an order of magnitude tighter, not a complete fix.
 *
 * Same honest limit as `ADMIN_MEDIA_UPLOAD_INITIATE_RATE_LIMIT`, recorded
 * rather than overstated: `ThrottlerGuard` keys on client IP, not on the
 * authenticated user id, so an attacker rotating source addresses is not
 * bounded by this, and legitimate users sharing one IP (office/campus NAT,
 * carrier-grade NAT on mobile networks) share a single bucket. A per-user
 * tracker would be the real fix and is not built here.
 */
export const VIDEO_PLAYBACK_URL_RATE_LIMIT = 60;
export const VIDEO_PLAYBACK_URL_RATE_TTL_MS = minutes(1);

/**
 * Work unit "ANONYMOUS FREE-EPISODE PLAYBACK" (Reviewer A, MEDIUM finding).
 * `GET /videos/:id/stream` became optional-auth in the same change that gave
 * `/videos/:id/playback` its override above, but was left on the generous
 * app-wide 300/min default — an inconsistency worth closing, because
 * `/stream` is the more expensive of the two: `/playback` is a DB read plus
 * string/signature construction, while `/stream` does real filesystem I/O
 * (`existsSync`/`statSync`/`createReadStream`) and, for a request with NO
 * `Range` header, streams an entire episode file.
 *
 * Honest about what actually changed: this route was never truly
 * registration-gated in any meaningful sense — one account (a single
 * `/auth/register` call) already yielded a token that could stream at the
 * full 300/min. So dropping the token requirement removes a thin barrier,
 * not a real one. This constant is therefore a genuine tightening for
 * EVERY caller — anonymous and authenticated alike — rather than a
 * guest-specific penalty, which is also why it is not set to `/playback`'s
 * 60: that ceiling is calibrated for one-URL-per-episode-view minting,
 * whereas a media player legitimately issues MANY requests for a single
 * episode (initial probe, buffer fills, one more per seek).
 *
 * 120/minute is roughly 4x the busiest minute a real viewer can produce (a
 * human cannot seek twice a second for a solid minute) while cutting the
 * worst-case unauthenticated bandwidth amplification from one IP by 60%.
 *
 * Carries the SAME caveat as `VIDEO_PLAYBACK_URL_RATE_LIMIT` above, for the
 * same reason: `ThrottlerGuard` keys on client IP, so an attacker rotating
 * source addresses is not bounded by this, and legitimate users behind one
 * NAT share a bucket. Bandwidth-level abuse protection belongs at the CDN/
 * edge, not here; this is a floor, not the defense.
 */
export const VIDEO_STREAM_RATE_LIMIT = 120;
export const VIDEO_STREAM_RATE_TTL_MS = minutes(1);

/**
 * Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION": `POST /payments/checkout`
 * creates a real transaction at an external payment provider on every
 * non-idempotent call — the exact `ADMIN_MEDIA_UPLOAD_INITIATE_RATE_LIMIT`
 * rationale ("a route that mints real, credential-backed external artifacts
 * must not inherit the cheap-local-computation default"), applied to a
 * provider-charging route instead of a presign-minting one, so it gets the
 * same dedicated-override treatment rather than the generous 300/min
 * default. 20/minute is far above any legitimate purchase pattern (a real
 * user checks out a handful of times per DAY, and a retried checkout for
 * the same plan is answered from the existing open order without a
 * provider call at all) while bounding what a stolen token can make this
 * backend do to the Midtrans API.
 *
 * Same honest limit as every other override in this file, recorded rather
 * than overstated: `ThrottlerGuard` keys on client IP, not user id, so an
 * attacker rotating source addresses is not bounded by it, and users
 * sharing one NAT share a bucket.
 */
export const PAYMENT_CHECKOUT_RATE_LIMIT = 20;
export const PAYMENT_CHECKOUT_RATE_TTL_MS = minutes(1);

/**
 * Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION": the Midtrans
 * notification webhook is UNAUTHENTICATED by design (provider authenticity
 * is proven by the SHA512 signature inside the body, not by a bearer
 * token), and this file's stated convention is that every unauthenticated
 * route gets an explicit tight override rather than the generous default.
 * Signature verification is cheap (one SHA512) but each accepted
 * notification costs a DB lookup + a possible transaction, so the bucket is
 * sized for the provider, not for browsers: Midtrans delivers one
 * notification per status change per order plus a bounded retry ladder
 * (2-5 retries), all from Midtrans infrastructure IPs. 120/minute per IP
 * comfortably covers a burst of concurrent settlements while capping how
 * fast a forger can hammer the signature check from one address. A 429
 * answered to a REAL Midtrans delivery is retried by their documented
 * retry policy and can additionally be recovered by
 * `reconcilePayment` (GET Status), so throttling here never strands a
 * payment permanently.
 */
export const PAYMENT_WEBHOOK_RATE_LIMIT = 120;
export const PAYMENT_WEBHOOK_RATE_TTL_MS = minutes(1);

/**
 * PHASE 10B — PRODUCTION IDENTITY PROVIDERS. Per-route IP throttles for the
 * three new UNAUTHENTICATED entry points, following the established
 * "every unauthenticated route gets an explicit tight override" precedent
 * the login/register/refresh/password-reset constants above set.
 *
 * A NOTE ON WHAT THESE DO AND DO NOT PROTECT, because it matters for
 * reviewing the WhatsApp limits in particular: every constant in this file
 * is COARSE, IN-MEMORY, PER-IP, PER-APPLICATION-INSTANCE throttling (see
 * this file's header). An attacker who rotates source IPs defeats all of
 * it. That is acceptable for `login`/`register` — the account-side damage
 * is separately bounded by the persistent PostgreSQL `AccountLockout` — and
 * it is why the OTP flow does NOT rely on these constants for its real
 * protection either: the per-NUMBER cooldown/budget and per-CHALLENGE
 * attempt limit in `src/auth/identity/auth-identity.constants.ts` are
 * database-backed, survive restarts, and apply across every instance and
 * every source IP. These are the outer, cheap layer; those are the load
 * -bearing one.
 */

/**
 * `POST /auth/google`: 10 requests per minute per IP. More generous than
 * `LOGIN_RATE_LIMIT` (5/min) on purpose — a Google sign-in involves no
 * server-side password guessing to slow down (the credential is a
 * cryptographically signed ID token that cannot be brute-forced), so the
 * limit exists only to bound the CPU cost of signature verification and the
 * rate of JWKS cache misses, not to protect a guessable secret. Still
 * tighter than the app-wide default, because the route is unauthenticated.
 */
export const GOOGLE_AUTH_RATE_LIMIT = 10;
export const GOOGLE_AUTH_RATE_TTL_MS = seconds(60);

/**
 * `POST /auth/whatsapp/otp/request`: 3 requests per 10 minutes per IP —
 * deliberately the SAME threshold as `REGISTER_RATE_LIMIT` and
 * `PASSWORD_RESET_REQUEST_RATE_LIMIT`, which it resembles exactly: an
 * unauthenticated, low-frequency-legitimate-use, state-creating action
 * where a genuine caller essentially never needs more than a couple of
 * attempts in a ten-minute window. Unlike those two, this action also
 * SENDS A MESSAGE that costs money and interrupts a real person, which is
 * why it is additionally bounded per phone number in the database.
 */
export const WHATSAPP_OTP_REQUEST_RATE_LIMIT = 3;
export const WHATSAPP_OTP_REQUEST_RATE_TTL_MS = minutes(10);

/**
 * `POST /auth/whatsapp/otp/verify`: 5 requests per minute per IP — the same
 * threshold as `LOGIN_RATE_LIMIT`, and for the same reason: this is the
 * route where a low-entropy secret is guessed, so it is the one that most
 * resembles a password prompt. The real defense against guessing a 6-digit
 * code is `OTP_MAX_ATTEMPTS` (counted atomically ON THE CHALLENGE ROW, so
 * it cannot be outrun by concurrency or by rotating IPs); this limit simply
 * makes the cheap outer layer consistent with the rest of the file.
 */
export const WHATSAPP_OTP_VERIFY_RATE_LIMIT = 5;
export const WHATSAPP_OTP_VERIFY_RATE_TTL_MS = seconds(60);

/**
 * Work unit "REWARDS BACKEND FOUNDATION". `POST /rewards/check-in` and
 * `POST /rewards/redemptions` are AUTHENTICATED routes that both open a
 * database transaction taking a per-account row lock, so they follow the
 * `ACCOUNT_DELETION_RATE_LIMIT` / `DATA_EXPORT_RATE_LIMIT` precedent of
 * "authenticated, but still gets a dedicated tighter override for a specific
 * reason" rather than inheriting the generous 300/min default.
 *
 * The reason here is NOT that the endpoints are dangerous to call twice —
 * they are idempotent by construction, which is the whole design, and a
 * replay writes nothing. It is that each call is a WRITE TRANSACTION that
 * serialises on the caller's `User` row. Left on the default, one stolen
 * token could hold that account's lock in a 300/min loop and make every
 * other transaction for the same account (login, password change, deletion)
 * queue behind it. The limit bounds lock pressure, not fraud — the ledger's
 * unique keys already make fraud a no-op.
 *
 * 30/minute for check-in is roughly an order of magnitude above any real
 * usage (a genuine user checks in ONCE A DAY; the only legitimate repeats
 * are a double-tap and a retry after a dropped connection) while leaving a
 * flaky-network client comfortable room.
 */
export const REWARD_CHECK_IN_RATE_LIMIT = 30;
export const REWARD_CHECK_IN_RATE_TTL_MS = minutes(1);

/**
 * `POST /rewards/redemptions`: 10 per minute. Tighter than check-in because
 * a redemption does strictly more work in its transaction — a ledger debit,
 * a receipt row, AND an `Entitlement` grant — and because, unlike check-in,
 * each accepted call legitimately CHANGES state (a user can hold several
 * redemptions), so retries are not automatically no-ops. Still far above a
 * real purchase pattern: a user redeeming ten times in one minute is not a
 * user.
 *
 * Same honest limit as every other override in this file: `ThrottlerGuard`
 * keys on client IP, not on the authenticated user id, so an attacker
 * rotating source addresses is not bounded by it, and users sharing one NAT
 * share a bucket. The load-bearing controls for this domain are the
 * database-backed ones — the unique idempotency keys and the balance floor —
 * not this.
 */
export const REWARD_REDEEM_RATE_LIMIT = 10;
export const REWARD_REDEEM_RATE_TTL_MS = minutes(1);

/**
 * Work unit "REWARDS V1 EARN AND SPEND". `POST /rewards/missions/:id/open`
 * and `POST /rewards/missions/:id/claim`: 20 per minute, sitting between
 * check-in's 30 and redemption's 10 for the reason the whole block gives —
 * lock pressure, not fraud.
 *
 * A claim opens the same kind of per-account write transaction a check-in
 * does. An OPEN does not (it is a single upsert with no `FOR UPDATE`), but
 * it shares the ceiling anyway: they are two halves of one user gesture, and
 * two different limits on "tap the tile" and "confirm the tile" would
 * produce a UI that fails halfway through for reasons no one can explain.
 *
 * 20/min is far above the real pattern — there are four social missions and
 * two watch milestones in the whole catalog, and each pays at most once per
 * account (or per reward day). Beyond that ceiling a caller is looping, and
 * every one of those loops is already a no-op against the ledger key.
 */
export const REWARD_MISSION_RATE_LIMIT = 20;
export const REWARD_MISSION_RATE_TTL_MS = minutes(1);

/**
 * Work unit "REWARDS V1 EARN AND SPEND". `POST /rewards/perks/:id/consume`:
 * 60 per minute — the LOOSEST override in this domain, deliberately.
 *
 * This one sits on the AD PATH. It is called when an interstitial would have
 * been shown, which is a normal, repeated part of a viewing session rather
 * than a once-a-day gesture, and a user who bought ad skips is a user who
 * paid to be interrupted less — throttling them into seeing the ad anyway
 * would be the worst possible failure of this feature. It is also the
 * cheapest write in the module: one conditional `UPDATE`, no transaction, no
 * row lock (see `RewardsPerksService`).
 *
 * `GET /rewards/perks` gets NO override at all and keeps the app-wide
 * default. It is a read the ad gate may consult before every ad break, and a
 * dedicated limit on it would be a limit on showing the right number of ads.
 */
export const REWARD_PERK_CONSUME_RATE_LIMIT = 60;
export const REWARD_PERK_CONSUME_RATE_TTL_MS = minutes(1);
