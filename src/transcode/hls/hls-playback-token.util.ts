import { createHmac } from 'crypto';
import {
  buildHlsHomePrefix,
  deriveActiveGenerationPrefix,
} from '../hls-staging-key.util';
import { HLS_MASTER_PLAYLIST_FILENAME } from './hls.constants';

/**
 * Slice 11Q — Private HLS Delivery Gateway (control-workspace DECISIONS.md
 * "2026-08-10 — Slice 11Q APPROVED..." entry; architecture:
 * proposals/phase-11-hls-pipeline-proposal.md §9/§9a). The backend's MINT
 * side of the shared token v1 contract — see
 * `workers/hls-gateway/src/token.ts`'s doc comment for the exact byte-for-
 * byte format both sides agree on, and
 * `workers/hls-gateway/test/token-vectors.json` (asserted against by BOTH
 * `hls-token-contract.spec.ts` here and the Worker's own `token.spec.ts`)
 * for the shared regression fixture.
 *
 *   payload = base64url(JSON.stringify({ v: 1, m: mediaId, p: authorizedPrefix, e: unixExpirySeconds }))
 *   sig     = base64url(HMAC-SHA256(secret, payload))
 *   token   = `${payload}.${sig}`
 *
 * Uses Node's `crypto.createHmac` (never a WebCrypto polyfill) — this file
 * only ever runs in the NestJS backend process, never in the Worker.
 * `base64url` is a native `Buffer` encoding since Node 15.7 — no manual
 * base64-to-base64url character substitution is needed on either side.
 *
 * NO userId CLAIM (frozen decision, proposal §9/decision 8 — see
 * `token.ts`'s doc comment for the full rationale): this token is
 * content/version-bound, not identity-bound. The audit trail for "which
 * user requested playback of what, when" lives entirely on the BACKEND's
 * own mint call (this function's caller, `VideosService`, runs inside the
 * already-authenticated+entitlement-checked `GET /videos/:id/playback`
 * request — the same structured logging any other authenticated route in
 * this app already gets), not inside the token itself.
 */

export interface HlsTokenPayloadV1 {
  v: 1;
  m: string;
  p: string;
  e: number;
}

export interface MintHlsTokenParams {
  mediaId: string;
  prefix: string;
  ttlSeconds: number;
  secret: string;
  /**
   * Injectable for deterministic tests (the contract-vector regression
   * pin, expiry-boundary tests) — defaults to the real wall clock. NEVER
   * read internally as `Date.now()` more than once per call, so a single
   * mint call's `exp` is always `nowSeconds + ttlSeconds` exactly.
   */
  nowSeconds?: number;
}

export interface MintedHlsToken {
  token: string;
  /** Unix seconds — the exact value embedded in the token's `e` claim. */
  exp: number;
  /** ISO-8601 — `exp` converted for direct use in an API response body. */
  expiresAt: string;
}

export function mintHlsToken(params: MintHlsTokenParams): MintedHlsToken {
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = now + params.ttlSeconds;

  const payload: HlsTokenPayloadV1 = {
    v: 1,
    m: params.mediaId,
    p: params.prefix,
    e: exp,
  };

  const payloadSegment = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
  const sigSegment = createHmac('sha256', params.secret)
    .update(payloadSegment)
    .digest('base64url');

  return {
    token: `${payloadSegment}.${sigSegment}`,
    exp,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/**
 * Derives the token's authorized prefix from a row's `hlsMasterKey` — the
 * immutable generation prefix (everything up to and including the final
 * `/` before `master.m3u8`), e.g.
 * `"admin-media/<mediaId>/hls/v3-a1-<uuid>/"`. Reuses
 * `deriveActiveGenerationPrefix` (Slice 11P, `hls-staging-key.util.ts`)
 * rather than re-deriving the same slicing logic a second time — this
 * function adds exactly one thing on top: a cross-check that the derived
 * prefix genuinely lives under THIS `mediaId`'s own home namespace
 * (`buildHlsHomePrefix(mediaId)`), so a corrupted/mismatched
 * `hlsMasterKey` (which should never happen given 11P's own write-path
 * guarantees — `promoteIfCurrent` only ever writes a key it just built
 * from the same row's own id) can never mint a token authorizing a
 * DIFFERENT media id's objects.
 *
 * Returns `null` (never throws) for a null/malformed/mismatched
 * `hlsMasterKey` — callers (`VideosService`) treat `null` as "this row
 * does not cleanly qualify for the HLS branch" and fall through to the
 * existing R2/local playback resolution, rather than surfacing an error
 * for a state that, per 11P's own write guarantees, should be
 * unreachable in practice.
 */
export function derivePrefixFromMasterKey(
  mediaId: string,
  hlsMasterKey: string | null,
): string | null {
  const prefix = deriveActiveGenerationPrefix(hlsMasterKey);
  if (!prefix) {
    return null;
  }

  const expectedHome = buildHlsHomePrefix(mediaId);
  if (!prefix.startsWith(expectedHome)) {
    return null;
  }

  // Sanity: prefix + the master playlist filename must reconstruct the
  // EXACT original hlsMasterKey — always true given how `prefix` was
  // derived, kept as an explicit assertion (not a silent assumption) for
  // the same belt-and-suspenders reasoning as the Worker's own
  // `buildObjectKey` prefix-containment check.
  if (`${prefix}${HLS_MASTER_PLAYLIST_FILENAME}` !== hlsMasterKey) {
    return null;
  }

  return prefix;
}
