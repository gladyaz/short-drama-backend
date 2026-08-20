/**
 * PHASE 10B — the Google identity PORT: the one boundary behind which every
 * Google OIDC detail lives. Mirrors the `MIDTRANS_GATEWAY` /
 * `TRANSCODE_QUEUE` interface + string-DI-token convention this repository
 * already uses for external providers, for the same reasons: business logic
 * (`AuthIdentityService`) depends only on this interface, and every unit/e2e
 * suite substitutes it with `.overrideProvider(GOOGLE_IDENTITY_VERIFIER)`,
 * so no test suite can ever make a real request to Google.
 *
 * Two implementations exist:
 * - `GoogleOidcIdentityVerifier` (`google-oidc.verifier.ts`): the real
 *   verifier, constructed by `AuthModule`'s factory ONLY when
 *   `GOOGLE_AUTH_ENABLED=true` AND at least one client id is configured.
 * - `DisabledGoogleIdentityVerifier` (`google-disabled.verifier.ts`): the
 *   inert default that rejects every call with `GOOGLE_AUTH_DISABLED`.
 */

/**
 * What the server is willing to believe about a caller after verifying a
 * Google ID token, and nothing more. Every field here comes from a
 * cryptographically verified token — NEVER from the request body.
 */
export interface GoogleVerifiedIdentity {
  /**
   * The OIDC `sub` claim: Google's stable, unique identifier for the
   * account. THIS is the identity key (`AuthIdentity.providerSubject`).
   * Google documents it as the only value guaranteed stable for an
   * account over time.
   */
  subject: string;
  /**
   * The `email` claim, lowercased — present only when the token carried
   * one AND `email_verified` was true. An unverified email is deliberately
   * dropped to `undefined` rather than passed along: Google itself does not
   * vouch for it, so this server must not treat it as evidence either
   * (it is used to decide profile email and account-collision outcomes).
   */
  email?: string;
  /** The `name` claim, if present — used only as an initial `displayName`. */
  displayName?: string;
}

export interface GoogleIdentityVerifier {
  /**
   * Verifies a Google ID token SERVER-SIDE and returns the claims that
   * survived verification.
   *
   * Implementations MUST reject (never return) unless all of the following
   * hold: the token is a well-formed JWS signed with RS256 by a key
   * currently published in Google's JWKS, `iss` is an exact match for one of
   * `GOOGLE_ISSUERS`, `aud` is an exact match for one of this server's
   * configured client ids, `exp` is in the future, `iat`/`nbf` are not in
   * the future, and `sub` is a non-empty string. Every failure surfaces as
   * the same generic `INVALID_GOOGLE_TOKEN` — the specific cause is for the
   * server-side audit trail, never the response.
   */
  verifyIdToken(idToken: string): Promise<GoogleVerifiedIdentity>;
}

/** DI token, following the `TRANSCODE_QUEUE`/`MIDTRANS_GATEWAY` string-token convention. */
export const GOOGLE_IDENTITY_VERIFIER = 'AUTH_GOOGLE_IDENTITY_VERIFIER';
