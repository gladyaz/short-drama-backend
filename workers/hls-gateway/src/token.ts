/**
 * Slice 11Q — HLS playback token v1: verification side (the Worker never
 * mints tokens — only the backend does, via
 * `short-drama-backend/src/transcode/hls/hls-playback-token.util.ts`, the
 * exact byte-for-byte counterpart to this file; see
 * `test/token-vectors.json` for the shared contract fixture both sides
 * assert against).
 *
 * Token v1 format (frozen, control-workspace DECISIONS.md "2026-08-10 —
 * Slice 11Q APPROVED..." entry, binding constraint 3):
 *
 *   payload = base64url(JSON.stringify({ v: 1, m: mediaId, p: authorizedPrefix, e: unixExpirySeconds }))
 *   sig     = base64url(HMAC-SHA256(secret, payload))
 *   token   = `${payload}.${sig}`
 *
 * `sig` is computed over the base64url-ENCODED payload string (not the raw
 * JSON bytes) — matching the JWT convention of signing the encoded segment,
 * so both sides never need to agree on JSON re-serialization to verify.
 *
 * Deliberately NO `userId` claim (proposal §9, frozen decision 8): this
 * token is content/version-bound, not identity-bound. A `uid` claim would
 * (a) fragment the canonical cache key this same slice's §9a amendment is
 * built around — two different users watching the same generation would
 * mint tokens that still share the same canonical object identity today,
 * but adding `uid` would invite a future temptation to key caching (or
 * even authorization) by it, defeating shared caching entirely — and (b)
 * add nothing security-relevant: the backend's `GET /videos/:id/playback`
 * already ran the real identity/entitlement check (see
 * `VideosService.getPlaybackUrl`) before ever minting a token; the token
 * itself only needs to prove "the backend already authorized SOME caller
 * for this exact generation, recently". Per-user audit trail (who was
 * playing what, when) is the backend's mint-time log, not this token.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Strict base64url alphabet — no padding characters (`=`) ever accepted. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface HlsTokenPayloadV1 {
  v: 1;
  m: string;
  p: string;
  e: number;
}

export interface VerifiedHlsToken {
  mediaId: string;
  prefix: string;
  exp: number;
}

/**
 * Strict base64url decode: rejects anything outside the base64url alphabet
 * (no `+`/`/`/`=`, no whitespace, no empty string) before ever attempting
 * to decode, and never throws — any failure (bad alphabet, malformed
 * length, invalid decoded byte sequence) returns `null` so callers can
 * fail closed uniformly.
 */
function base64UrlDecode(value: string): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  if (!BASE64URL_PATTERN.test(value)) {
    return null;
  }

  try {
    const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
    const standardBase64 = padded.replace(/-/g, '+').replace(/_/g, '/');
    // `atob` is a global in both the Workers runtime and Node >= 16 — no
    // Buffer/node:* import needed, keeping this module runtime-agnostic.
    const binary = atob(standardBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function isValidPayloadShape(value: unknown): value is HlsTokenPayloadV1 {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const keys = Object.keys(value).sort();
  // Exactly these four keys — a v1 payload with extra or missing fields is
  // treated as malformed, not leniently accepted (this is a fixed-shape,
  // version-tagged contract; a shape drift is exactly the kind of thing
  // "fail closed on any malformation" is meant to catch).
  if (keys.length !== 4 || keys.join(',') !== 'e,m,p,v') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.v === 1 &&
    typeof candidate.m === 'string' &&
    candidate.m.length > 0 &&
    typeof candidate.p === 'string' &&
    candidate.p.length > 0 &&
    typeof candidate.e === 'number' &&
    Number.isInteger(candidate.e)
  );
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

/**
 * Verifies a token string against `secret`, returning the decoded claims
 * only when EVERY check passes: well-formed `<payload>.<sig>` shape, valid
 * base64url on both segments, a genuine HMAC-SHA256 match (verified via
 * `crypto.subtle.verify` — constant-time by construction, never a manual
 * byte-by-byte string comparison, which would not be constant-time), valid
 * v1 JSON payload shape, and `exp` strictly in the future relative to
 * `now`. Any single failure returns `null` — never throws, never
 * distinguishes WHICH check failed to the caller (that distinction is
 * exactly what `index.ts`'s uniform 403 response is for).
 *
 * `now` is a caller-supplied unix-seconds value (never `Date.now()` read
 * internal to this function) so tests can pin it — see
 * `test/token-vectors.json`'s fixed reference clock.
 */
export async function verify(
  tokenString: string,
  secret: string,
  now: number,
): Promise<VerifiedHlsToken | null> {
  if (typeof tokenString !== 'string' || tokenString.length === 0) {
    return null;
  }

  const parts = tokenString.split('.');
  if (parts.length !== 2) {
    return null;
  }

  const [payloadSegment = '', sigSegment = ''] = parts;
  const payloadBytes = base64UrlDecode(payloadSegment);
  const sigBytes = base64UrlDecode(sigSegment);
  if (!payloadBytes || !sigBytes) {
    return null;
  }

  let key: CryptoKey;
  try {
    key = await importHmacKey(secret);
  } catch {
    return null;
  }

  let signatureValid = false;
  try {
    signatureValid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes as BufferSource,
      textEncoder.encode(payloadSegment) as BufferSource,
    );
  } catch {
    return null;
  }

  if (!signatureValid) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(payloadBytes));
  } catch {
    return null;
  }

  if (!isValidPayloadShape(parsed)) {
    return null;
  }

  // Fail closed at the boundary too: `exp === now` is treated as already
  // expired, never as "still valid for this instant".
  if (parsed.e <= now) {
    return null;
  }

  return { mediaId: parsed.m, prefix: parsed.p, exp: parsed.e };
}
