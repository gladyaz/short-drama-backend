/**
 * PHASE 10B — PRODUCTION IDENTITY PROVIDERS. Named constants for the
 * provider-neutral identity layer, kept centralized here (never inline)
 * per `common/coding-style.md`'s "no hardcoded values" rule, matching
 * `src/auth/auth.constants.ts`'s existing role for the email/password half
 * of this same module.
 */

/**
 * The CLOSED set of authentication providers this backend supports. Stored
 * in `AuthIdentity.provider` as a plain string (see that model's schema doc
 * comment for why a Postgres enum was deliberately not used) and validated
 * against this union at the application layer.
 *
 * `email` is listed FIRST and is not a second-class citizen: it remains a
 * fully supported, primary way to sign in. This phase adds providers
 * alongside it; it never replaces it.
 */
export const AUTH_PROVIDERS = ['email', 'google', 'whatsapp'] as const;

export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

/**
 * The providers a caller may LINK to (and UNLINK from) an already
 * authenticated account. Deliberately excludes `email`: an email identity is
 * inseparable from `User.email` + `User.passwordHash`, whose lifecycle is
 * owned by the existing, already-hardened `register` / `change-password` /
 * `password-reset` / `account-deletion` flows. Letting a generic
 * link/unlink route add or remove a password credential would create a
 * second, unreviewed path into those invariants — the exact kind of
 * duplication the "do not regress any existing auth-hardening invariant"
 * constraint exists to prevent.
 */
export const LINKABLE_AUTH_PROVIDERS = ['google', 'whatsapp'] as const;

export type LinkableAuthProvider = (typeof LINKABLE_AUTH_PROVIDERS)[number];

export function isLinkableAuthProvider(
  value: string,
): value is LinkableAuthProvider {
  return (LINKABLE_AUTH_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Number of decimal digits in a WhatsApp OTP code. Six is the near-universal
 * convention for SMS/WhatsApp one-time codes (it is what users expect to
 * read off a message and retype), and its 10^6 keyspace is defended NOT by
 * its own size but by the three bounds around it: `OTP_MAX_ATTEMPTS`
 * guesses per challenge, `OTP_TTL_MS` before it dies, and a per-number
 * request budget that stops an attacker from simply asking for fresh
 * challenges to keep guessing. Raising this number would improve nothing
 * those three bounds do not already cover, at a real cost in usability.
 */
export const OTP_CODE_DIGITS = 6;

/**
 * Five minutes. Long enough for a real person to switch to WhatsApp, read a
 * message and type six digits back (including a slow network or a
 * locked phone), short enough that a code observed on a lock screen or left
 * in a shared device's notification history stops being useful quickly.
 */
export const OTP_TTL_MS = 5 * 60 * 1000;

/**
 * Wrong guesses a single challenge tolerates before it is permanently
 * unusable. With `OTP_CODE_DIGITS = 6`, five attempts give an attacker a
 * 5-in-1,000,000 chance per challenge — and because every attempt is
 * counted by an atomic, single-statement conditional `UPDATE` (not a
 * read-modify-write), that budget cannot be bypassed by firing guesses
 * concurrently.
 */
export const OTP_MAX_ATTEMPTS = 5;

/**
 * Minimum spacing between two OTP requests for the SAME phone number.
 * Enforced against the database (`PhoneOtpChallenge.createdAt`), so it
 * survives a restart and applies across every backend instance and every
 * source IP — unlike the per-IP `@Throttle()` on the same route, which an
 * attacker defeats simply by rotating IPs. Every OTP is a real message to a
 * real person's phone that costs money to send, so the per-NUMBER bound is
 * the one that actually protects the victim.
 */
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;

/**
 * Rolling window and cap for per-number OTP requests, layered ON TOP of the
 * cooldown above: the cooldown alone would still permit 60 messages an hour
 * to one number from a patient attacker. Five requests per hour comfortably
 * covers a genuine user who mistypes their number, never receives the first
 * message, and tries again — while bounding an SMS/WhatsApp-bombing
 * campaign against one victim to something they can ignore.
 */
export const OTP_REQUEST_WINDOW_MS = 60 * 60 * 1000;
export const OTP_MAX_REQUESTS_PER_WINDOW = 5;

/**
 * How long a `PhoneOtpChallenge` row survives after it stops being usable,
 * before `AuthIdentityService.requestOtp` prunes it opportunistically.
 *
 * The row holds a PHONE NUMBER — personal data belonging to someone who may
 * have no account here at all, and who therefore has nothing to delete and
 * no way to ask. It is not cascaded away by account deletion (the table has
 * no owning `User` — deliberately, see the model's schema doc comment), so
 * a retention bound is the only thing that ever removes it. 24 hours keeps
 * enough history to investigate an abuse burst reported the same day
 * without accumulating numbers indefinitely.
 */
export const OTP_CHALLENGE_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Hard cap on rows deleted by one opportunistic prune, so the cleanup can
 * never turn a single OTP request into an unbounded `DELETE` that locks the
 * table (e.g. the first request after a long outage). Anything left over is
 * simply collected by the next request — mirroring the bounded-batch
 * discipline `SeriesCoverOrphanService` already applies to its own cleanup.
 */
export const OTP_PRUNE_BATCH_LIMIT = 500;

/**
 * Fixed, non-secret domain-separation tag mixed into
 * `AuthIdentityService.hashOtpCode`'s HMAC input, alongside the phone
 * number itself. Serves the same purpose as
 * `PASSWORD_RESET_TOKEN_HASH_DOMAIN` (`auth.constants.ts`): the OTP hash
 * shares `JWT_REFRESH_SECRET` with `Session.refreshTokenHash` and
 * `PasswordResetToken.tokenHash`, and the tag guarantees the three can
 * never be computed from the same input, so no future "look up any bearer
 * value by hash" helper can confuse one for another. The value is not
 * sensitive — the KEY is — it only needs to be fixed and distinct.
 */
export const OTP_CODE_HASH_DOMAIN = 'whatsapp-otp:v1:';

/**
 * The `iss` values Google is documented to issue for ID tokens. BOTH forms
 * are accepted because Google itself emits both, and a verifier that
 * accepts only one will reject legitimate tokens
 * (https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).
 * This is an exact-match allowlist — never a `endsWith('google.com')`-style
 * check, which `accounts.google.com.evil.example` would satisfy.
 */
export const GOOGLE_ISSUERS = [
  'accounts.google.com',
  'https://accounts.google.com',
] as const;

/** Google's published JWKS endpoint for ID-token signing keys (OIDC discovery `jwks_uri`). */
export const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';

/**
 * The ONLY JWS algorithm accepted for a Google ID token. Pinned to an
 * allowlist of exactly one rather than trusting the token's own `alg`
 * header, which is the classic JWT confusion attack: a token claiming
 * `alg: "none"` or a symmetric `HS256` (verified against the RSA PUBLIC key
 * as if it were an HMAC secret — and that key is public) would otherwise
 * verify. Google signs ID tokens with RS256.
 */
export const GOOGLE_ID_TOKEN_ALGORITHM = 'RS256';

/**
 * Clock skew tolerated when checking a Google ID token's `exp`/`iat`/`nbf`.
 * Small, deliberate, and applied symmetrically: without it, a server whose
 * clock runs a few seconds fast rejects freshly issued, perfectly valid
 * tokens. 60 seconds is the customary allowance and is far shorter than the
 * ~1 hour lifetime of the tokens themselves.
 */
export const GOOGLE_CLOCK_SKEW_MS = 60 * 1000;

/**
 * Ceiling on how long a fetched JWKS document is reused before being
 * re-fetched. Google rotates ID-token signing keys periodically and
 * publishes a `Cache-Control: max-age` header; `GoogleOidcIdentityVerifier`
 * honours that header when present and falls back to this value otherwise,
 * and additionally caps any advertised max-age at this value so a
 * mis-set/hostile header cannot pin a stale key set indefinitely.
 */
export const GOOGLE_JWKS_CACHE_MAX_MS = 60 * 60 * 1000;

/**
 * Hard timeout on the JWKS fetch. Without it, a hung connection to Google
 * would hold a request (and its Node event-loop slot) open indefinitely on
 * an unauthenticated endpoint — a trivial resource-exhaustion lever.
 */
export const GOOGLE_JWKS_FETCH_TIMEOUT_MS = 5000;

/**
 * Upper bound on the raw ID token accepted from a client, checked BEFORE any
 * parsing, base64 decoding or signature work. A real Google ID token is
 * ~1KB; this bounds the CPU an unauthenticated caller can spend on the
 * verify path by sending a multi-megabyte "token".
 */
export const MAX_GOOGLE_ID_TOKEN_LENGTH = 8192;

/**
 * The `email` provider value, exported as a named constant so
 * `AuthService.register` can write an `email` identity row without importing
 * the whole union (and without a bare string literal that a rename would
 * silently miss). The migration's backfill writes the same literal.
 */
export const EMAIL_AUTH_PROVIDER: AuthProvider = 'email';
