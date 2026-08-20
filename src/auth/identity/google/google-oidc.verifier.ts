import { createPublicKey, createVerify, type KeyObject } from 'crypto';
import {
  GOOGLE_JWKS_CACHE_MAX_MS,
  GOOGLE_JWKS_FETCH_TIMEOUT_MS,
  GOOGLE_JWKS_URI,
} from '../auth-identity.constants';
import {
  decodeGoogleIdToken,
  GoogleTokenRejected,
  validateGoogleClaims,
} from './google-id-token.util';
import {
  GoogleIdentityVerifier,
  GoogleVerifiedIdentity,
} from './google-identity.types';

/**
 * PHASE 10B — the REAL Google ID-token verifier.
 *
 * WHAT IT DOES, in the order Google's own documentation prescribes
 * (https://developers.google.com/identity/gsi/web/guides/verify-google-id-token,
 * "Verify the Google ID token on your server side"):
 *   1. decompose the compact JWS and pin `alg` to RS256
 *      (`decodeGoogleIdToken`);
 *   2. fetch Google's published signing keys from the OIDC `jwks_uri` and
 *      select the one named by the token's `kid`;
 *   3. verify the RSA signature over the exact `<header>.<payload>` bytes;
 *   4. only THEN validate `iss` / `aud` / `exp` / `iat` / `nbf` / `sub`
 *      (`validateGoogleClaims`).
 *
 * Signature first, claims second, is deliberate: no claim from an unverified
 * token is worth reading, and reversing the order invites code that "just
 * checks the audience" against attacker-authored JSON.
 *
 * WHY THIS IS HAND-ROLLED against Node's built-in `crypto` rather than
 * `google-auth-library`: it follows this repository's established precedent
 * for external providers — `HttpMidtransClient` is likewise written directly
 * against the documented HTTP contract rather than the vendor SDK — and it
 * keeps the auth-critical path free of transitive dependencies. The
 * primitives used are Node's own: `createPublicKey({ format: 'jwk' })` to
 * import a JWK, and `createVerify('RSA-SHA256')` to verify RS256. Adopting
 * `google-auth-library` later is a drop-in replacement for exactly this one
 * class, because everything else depends only on `GoogleIdentityVerifier`.
 *
 * NO CREDENTIAL LIVES HERE. Verifying an ID token requires only Google's
 * PUBLIC keys and this server's client id (which is public by construction —
 * it ships inside the mobile app). The OAuth client SECRET is not needed for
 * this flow and is deliberately never read, stored, or logged by this class.
 */

/** The subset of a JWKS entry this verifier uses. */
interface GoogleJsonWebKey {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

/**
 * Injected so tests exercise the real signature/claim logic against
 * generated RSA keys with NO network access whatsoever — see
 * `google-oidc.verifier.spec.ts`. Production passes `globalThis.fetch`.
 */
export type JwksFetcher = (
  uri: string,
  timeoutMs: number,
) => Promise<JwksFetchResult>;

export interface JwksFetchResult {
  keys: GoogleJsonWebKey[];
  /** `Cache-Control: max-age` in ms, when the response advertised one. */
  maxAgeMs?: number;
}

export interface GoogleOidcIdentityVerifierOptions {
  /** Exact-match allowlist of acceptable `aud` values (this server's OAuth client ids). */
  allowedAudiences: readonly string[];
  jwksUri?: string;
  fetchJwks?: JwksFetcher;
  /** Injected clock, so expiry boundaries are testable without waiting. */
  now?: () => Date;
}

export class GoogleOidcIdentityVerifier implements GoogleIdentityVerifier {
  private readonly allowedAudiences: readonly string[];
  private readonly jwksUri: string;
  private readonly fetchJwks: JwksFetcher;
  private readonly now: () => Date;

  private cachedKeys: Map<string, KeyObject> | undefined;
  private cacheExpiresAtMs = 0;
  /**
   * De-duplicates concurrent JWKS fetches. Without it, a burst of sign-ins
   * arriving on a cold cache would each open their own request to Google —
   * a self-inflicted thundering herd on an unauthenticated endpoint.
   */
  private inFlightRefresh: Promise<Map<string, KeyObject>> | undefined;

  constructor(options: GoogleOidcIdentityVerifierOptions) {
    if (options.allowedAudiences.length === 0) {
      // Fail at CONSTRUCTION, not at request time. A verifier with an empty
      // audience allowlist can never accept anything (see
      // `validateGoogleClaims`), so building one is a configuration bug
      // worth surfacing immediately rather than as a stream of confusing
      // 401s. `AuthModule`'s factory never constructs one in that state.
      throw new Error(
        'GoogleOidcIdentityVerifier requires at least one allowed audience (GOOGLE_OAUTH_CLIENT_IDS). Values are never logged.',
      );
    }

    this.allowedAudiences = options.allowedAudiences;
    this.jwksUri = options.jwksUri ?? GOOGLE_JWKS_URI;
    this.fetchJwks = options.fetchJwks ?? defaultJwksFetcher;
    this.now = options.now ?? (() => new Date());
  }

  async verifyIdToken(idToken: string): Promise<GoogleVerifiedIdentity> {
    const decoded = decodeGoogleIdToken(idToken);

    if (!decoded.header.kid) {
      throw new GoogleTokenRejected('missing_kid');
    }

    const publicKey = await this.resolveSigningKey(decoded.header.kid);

    const verifier = createVerify('RSA-SHA256');
    verifier.update(decoded.signingInput);
    verifier.end();

    if (!verifier.verify(publicKey, decoded.signature)) {
      throw new GoogleTokenRejected('bad_signature');
    }

    const validated = validateGoogleClaims(
      decoded.claims,
      this.allowedAudiences,
      this.now(),
    );

    return {
      subject: validated.subject,
      email: validated.email,
      displayName: validated.displayName,
    };
  }

  /**
   * Returns the public key for `kid`, refreshing the JWKS at most once per
   * call. The single retry on a cache MISS is what makes Google's key
   * rotation transparent: a token signed with a brand-new key arrives, the
   * cached set does not contain its `kid`, and one forced refresh picks the
   * new key up. Bounding it to one refresh is equally deliberate — an
   * attacker submitting tokens with random `kid` values must not be able to
   * drive one Google fetch per request.
   */
  private async resolveSigningKey(kid: string): Promise<KeyObject> {
    const cached = this.cachedKeysIfFresh();
    const hit = cached?.get(kid);
    if (hit) {
      return hit;
    }

    const refreshed = await this.refreshKeys();
    const key = refreshed.get(kid);
    if (!key) {
      throw new GoogleTokenRejected('unknown_key');
    }
    return key;
  }

  private cachedKeysIfFresh(): Map<string, KeyObject> | undefined {
    if (!this.cachedKeys || this.now().getTime() >= this.cacheExpiresAtMs) {
      return undefined;
    }
    return this.cachedKeys;
  }

  private async refreshKeys(): Promise<Map<string, KeyObject>> {
    // Join an in-flight refresh rather than starting a second one.
    if (this.inFlightRefresh) {
      return this.inFlightRefresh;
    }

    const refresh = this.performRefresh().finally(() => {
      this.inFlightRefresh = undefined;
    });
    this.inFlightRefresh = refresh;
    return refresh;
  }

  private async performRefresh(): Promise<Map<string, KeyObject>> {
    const result = await this.fetchJwks(
      this.jwksUri,
      GOOGLE_JWKS_FETCH_TIMEOUT_MS,
    );

    const keys = new Map<string, KeyObject>();
    for (const jwk of result.keys) {
      // Only RSA signing keys are usable for RS256. Anything else in the
      // document is ignored rather than trusted — the algorithm this
      // verifier accepts is decided by `GOOGLE_ID_TOKEN_ALGORITHM`, never
      // by what the key set happens to advertise.
      if (!jwk.kid || jwk.kty !== 'RSA' || !jwk.n || !jwk.e) {
        continue;
      }
      if (jwk.alg !== undefined && jwk.alg !== 'RS256') {
        continue;
      }
      if (jwk.use !== undefined && jwk.use !== 'sig') {
        continue;
      }

      try {
        keys.set(
          jwk.kid,
          createPublicKey({
            key: { kty: 'RSA', n: jwk.n, e: jwk.e },
            format: 'jwk',
          }),
        );
      } catch {
        // A single unparseable entry must not poison the whole key set —
        // the remaining keys are still perfectly usable, and a token
        // needing the broken one simply fails as `unknown_key`.
        continue;
      }
    }

    if (keys.size === 0) {
      // Never cache an empty key set: doing so would turn one bad response
      // from Google into a full cache-lifetime outage of Google sign-in.
      throw new GoogleTokenRejected('unknown_key');
    }

    this.cachedKeys = keys;
    // An advertised max-age is honoured but CAPPED, so a mis-set (or
    // hostile, e.g. via a compromised intermediary) `Cache-Control` header
    // cannot pin a stale — potentially revoked — key set indefinitely.
    this.cacheExpiresAtMs =
      this.now().getTime() +
      Math.min(
        result.maxAgeMs ?? GOOGLE_JWKS_CACHE_MAX_MS,
        GOOGLE_JWKS_CACHE_MAX_MS,
      );

    return keys;
  }
}

/**
 * Production JWKS transport: a plain `fetch` with a hard timeout. Google's
 * key endpoint is public — no credential, header or cookie is sent, and no
 * response body other than the parsed key list is retained or logged.
 */
async function defaultJwksFetcher(
  uri: string,
  timeoutMs: number,
): Promise<JwksFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(uri, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });

    if (!response.ok) {
      throw new GoogleTokenRejected('unknown_key');
    }

    const body = (await response.json()) as { keys?: GoogleJsonWebKey[] };

    return {
      keys: Array.isArray(body.keys) ? body.keys : [],
      maxAgeMs: parseMaxAgeMs(response.headers.get('cache-control')),
    };
  } catch (error) {
    if (error instanceof GoogleTokenRejected) {
      throw error;
    }
    // A network failure, abort or malformed body must not leak transport
    // detail (URLs, socket errors) to the caller — it becomes the same
    // generic rejection every other failure produces.
    throw new GoogleTokenRejected('unknown_key');
  } finally {
    clearTimeout(timer);
  }
}

function parseMaxAgeMs(cacheControl: string | null): number | undefined {
  if (!cacheControl) {
    return undefined;
  }

  const match = /max-age=(\d+)/i.exec(cacheControl);
  if (!match) {
    return undefined;
  }

  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}
