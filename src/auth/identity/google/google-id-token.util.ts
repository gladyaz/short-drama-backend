import { HttpStatus } from '@nestjs/common';
import { AppErrorCode } from '../../../common/errors/app-error-code';
import { AppException } from '../../../common/errors/app.exception';
import {
  GOOGLE_CLOCK_SKEW_MS,
  GOOGLE_ID_TOKEN_ALGORITHM,
  GOOGLE_ISSUERS,
  MAX_GOOGLE_ID_TOKEN_LENGTH,
} from '../auth-identity.constants';

/**
 * PHASE 10B — the pure, network-free half of Google ID-token verification:
 * JWS decomposition and claim validation. Split out from
 * `GoogleOidcIdentityVerifier` (which owns the JWKS fetch and the RSA
 * signature check) so that every claim rule below is exhaustively unit
 * testable without any HTTP involvement at all — the rules are where the
 * security-relevant decisions live, so they must be the easiest part to
 * test, not the hardest.
 *
 * Nothing here trusts anything a client sent. In particular the `alg` header
 * is checked against a single-value allowlist rather than used to select a
 * verification strategy — see `GOOGLE_ID_TOKEN_ALGORITHM` for why that
 * distinction is the difference between a verifier and a rubber stamp.
 */

/** Generic, non-discriminating rejection — see `AppErrorCode.INVALID_GOOGLE_TOKEN`. */
export function invalidGoogleToken(): AppException {
  return new AppException(
    AppErrorCode.INVALID_GOOGLE_TOKEN,
    'Invalid Google credential',
    HttpStatus.UNAUTHORIZED,
  );
}

/**
 * Internal, non-client-facing reason a token was rejected. Recorded in the
 * server-side audit trail (`google_auth_failed`'s `reason`) so an operator
 * can tell a misconfigured client id apart from an expired token — while
 * the caller receives the identical generic error for all of them. This is
 * the same "generic client response, disambiguated audit reason" split
 * `login_failed` already establishes in `auth-audit.types.ts`.
 */
export type GoogleTokenRejectionReason =
  | 'malformed'
  | 'unsupported_algorithm'
  | 'missing_kid'
  | 'unknown_key'
  | 'bad_signature'
  | 'bad_issuer'
  | 'bad_audience'
  | 'expired'
  | 'not_yet_valid'
  | 'missing_subject';

/** Thrown internally so the caller can audit `reason` and answer generically. */
export class GoogleTokenRejected extends Error {
  constructor(readonly reason: GoogleTokenRejectionReason) {
    super(`google id token rejected: ${reason}`);
  }
}

export interface GoogleIdTokenHeader {
  alg: string;
  kid?: string;
}

export interface GoogleIdTokenClaims {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  exp?: unknown;
  iat?: unknown;
  nbf?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
}

export interface DecodedGoogleIdToken {
  header: GoogleIdTokenHeader;
  claims: GoogleIdTokenClaims;
  /** The exact `<header>.<payload>` bytes the signature covers. */
  signingInput: string;
  signature: Buffer;
}

/**
 * Splits and base64url-decodes a compact JWS. Performs NO cryptography and
 * grants NO trust — a token that decodes here is still entirely unverified;
 * it has merely been shown to have the right shape to be worth checking.
 */
export function decodeGoogleIdToken(idToken: unknown): DecodedGoogleIdToken {
  if (
    typeof idToken !== 'string' ||
    idToken.length === 0 ||
    idToken.length > MAX_GOOGLE_ID_TOKEN_LENGTH
  ) {
    throw new GoogleTokenRejected('malformed');
  }

  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new GoogleTokenRejected('malformed');
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (
    encodedHeader.length === 0 ||
    encodedPayload.length === 0 ||
    encodedSignature.length === 0
  ) {
    throw new GoogleTokenRejected('malformed');
  }

  const header = parseJsonSegment(encodedHeader);
  const claims = parseJsonSegment(encodedPayload);

  const alg = header.alg;
  if (typeof alg !== 'string') {
    throw new GoogleTokenRejected('malformed');
  }

  // Single-value allowlist, checked BEFORE anything else uses the header.
  // `alg: "none"` and any symmetric algorithm are rejected here rather than
  // being handed to a verifier that might treat Google's PUBLIC key as an
  // HMAC secret.
  if (alg !== GOOGLE_ID_TOKEN_ALGORITHM) {
    throw new GoogleTokenRejected('unsupported_algorithm');
  }

  const kid = header.kid;
  if (kid !== undefined && typeof kid !== 'string') {
    throw new GoogleTokenRejected('malformed');
  }

  return {
    header: { alg, kid },
    claims,
    signingInput: `${encodedHeader}.${encodedPayload}`,
    signature: Buffer.from(encodedSignature, 'base64url'),
  };
}

function parseJsonSegment(
  segment: string,
): GoogleIdTokenClaims & GoogleIdTokenHeaderCandidate {
  let decoded: string;
  try {
    decoded = Buffer.from(segment, 'base64url').toString('utf8');
  } catch {
    throw new GoogleTokenRejected('malformed');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new GoogleTokenRejected('malformed');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new GoogleTokenRejected('malformed');
  }

  return parsed;
}

/**
 * The header fields this verifier reads, typed as `unknown` so every one of
 * them is narrowed explicitly before use rather than trusted off a decoded
 * attacker-supplied JSON object.
 */
interface GoogleIdTokenHeaderCandidate {
  alg?: unknown;
  kid?: unknown;
}

/**
 * What survives claim validation: the fields the application is willing to
 * act on. `email` is present ONLY when Google asserted `email_verified`.
 */
export interface ValidatedGoogleClaims {
  subject: string;
  email?: string;
  displayName?: string;
}

/**
 * Validates the security-relevant claims of an ALREADY
 * SIGNATURE-VERIFIED token. Deliberately takes `allowedAudiences` and `now`
 * as parameters rather than reading config or the clock itself, so every
 * boundary condition (a token one second past expiry, a token from a
 * second configured client id, a token whose `iat` is in the future) is
 * directly expressible in a test.
 *
 * `aud` handling: Google issues a single string `aud` for ID tokens, but the
 * JWT specification permits an array, so both are accepted and each entry is
 * compared by EXACT equality against the configured allowlist. An allowlist
 * (rather than one id) is what lets one backend serve several OAuth clients
 * — an Android app, an iOS app and a web client each have their own client
 * id, and all three are legitimate audiences for the same account.
 */
export function validateGoogleClaims(
  claims: GoogleIdTokenClaims,
  allowedAudiences: readonly string[],
  now: Date,
): ValidatedGoogleClaims {
  const nowMs = now.getTime();

  if (
    typeof claims.iss !== 'string' ||
    !(GOOGLE_ISSUERS as readonly string[]).includes(claims.iss)
  ) {
    throw new GoogleTokenRejected('bad_issuer');
  }

  if (!audienceMatches(claims.aud, allowedAudiences)) {
    throw new GoogleTokenRejected('bad_audience');
  }

  const exp = numericClaim(claims.exp);
  if (exp === undefined) {
    throw new GoogleTokenRejected('malformed');
  }
  if (exp * 1000 + GOOGLE_CLOCK_SKEW_MS <= nowMs) {
    throw new GoogleTokenRejected('expired');
  }

  // `iat`/`nbf` in the future indicate a token that was not issued by the
  // clock this server shares with Google — treated as invalid rather than
  // waited out.
  const iat = numericClaim(claims.iat);
  if (iat !== undefined && iat * 1000 - GOOGLE_CLOCK_SKEW_MS > nowMs) {
    throw new GoogleTokenRejected('not_yet_valid');
  }

  const nbf = numericClaim(claims.nbf);
  if (nbf !== undefined && nbf * 1000 - GOOGLE_CLOCK_SKEW_MS > nowMs) {
    throw new GoogleTokenRejected('not_yet_valid');
  }

  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    throw new GoogleTokenRejected('missing_subject');
  }

  return {
    subject: claims.sub,
    email: verifiedEmail(claims),
    displayName:
      typeof claims.name === 'string' && claims.name.trim().length > 0
        ? claims.name.trim()
        : undefined,
  };
}

/**
 * An email is only returned when Google explicitly asserted it is verified.
 * Google sends `email_verified` as either a boolean or the STRING `"true"`
 * depending on the flow, so both are accepted — but nothing else is, and in
 * particular a MISSING `email_verified` is treated as unverified rather
 * than assumed true. This is the claim that ultimately decides whether a
 * Google sign-in is allowed to collide with an existing email account, so
 * "absent" must fail closed.
 */
function verifiedEmail(claims: GoogleIdTokenClaims): string | undefined {
  const isVerified =
    claims.email_verified === true || claims.email_verified === 'true';

  if (!isVerified || typeof claims.email !== 'string') {
    return undefined;
  }

  const normalized = claims.email.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function audienceMatches(
  aud: unknown,
  allowedAudiences: readonly string[],
): boolean {
  // An empty allowlist can never match. This is reachable only if the
  // module factory bound the real verifier without any configured client
  // id, which `AuthModule`'s factory refuses to do — belt and braces, so a
  // future refactor cannot turn "no audience configured" into "any
  // audience accepted".
  if (allowedAudiences.length === 0) {
    return false;
  }

  if (typeof aud === 'string') {
    return allowedAudiences.includes(aud);
  }

  if (Array.isArray(aud)) {
    return aud.some(
      (entry) => typeof entry === 'string' && allowedAudiences.includes(entry),
    );
  }

  return false;
}

/** JWT numeric date: seconds since the epoch, and only ever a finite number. */
function numericClaim(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}
