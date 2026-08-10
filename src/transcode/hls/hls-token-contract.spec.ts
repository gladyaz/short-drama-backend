import { readFileSync } from 'fs';
import { join } from 'path';
import { mintHlsToken } from './hls-playback-token.util';

/**
 * Slice 11Q — Backend<->Worker HLS token CONTRACT regression test.
 * `workers/hls-gateway/test/token-vectors.json` is a SHARED fixture read by
 * BOTH this backend jest spec and the Worker's own vitest spec
 * (`workers/hls-gateway/test/token.spec.ts`) — this file proves
 * `mintHlsToken` reproduces every "valid*" vector byte-for-byte given the
 * exact same inputs; the Worker's spec independently proves `verify()`
 * accepts those same vectors and rejects every tampered/expired/
 * wrong-secret one, via WebCrypto rather than Node's `crypto` module. The
 * two runtimes agreeing on the exact same bytes is the actual proof that
 * HMAC-SHA256 interop holds across this backend<->Worker boundary — this
 * is not exercised by mocking either side against the other.
 *
 * `secret`/`mediaId`/`prefix` values in the fixture are entirely SYNTHETIC
 * (fixture-only, never a real secret or a real media identity), and `now`
 * is a FIXED reference clock (not real wall-clock time), so this test is
 * fully deterministic regardless of when it actually runs.
 */
interface TokenVectors {
  secret: string;
  wrongSecret: string;
  mediaId: string;
  prefix: string;
  otherMediaId: string;
  otherPrefix: string;
  genNextPrefix: string;
  now: number;
  validExp: number;
  expiredExp: number;
  valid: string;
  expired: string;
  validDifferentPrefix: string;
  validNextGeneration: string;
  tamperedSignature: string;
  wrongSecretToken: string;
}

const vectors = JSON.parse(
  readFileSync(
    join(__dirname, '../../../workers/hls-gateway/test/token-vectors.json'),
    'utf8',
  ),
) as TokenVectors;

describe('HLS token backend<->Worker contract (Slice 11Q)', () => {
  it('mintHlsToken reproduces the shared "valid" vector byte-for-byte', () => {
    const result = mintHlsToken({
      mediaId: vectors.mediaId,
      prefix: vectors.prefix,
      ttlSeconds: vectors.validExp - vectors.now,
      secret: vectors.secret,
      nowSeconds: vectors.now,
    });
    expect(result.token).toBe(vectors.valid);
    expect(result.exp).toBe(vectors.validExp);
  });

  it('mintHlsToken reproduces the shared "expired" vector byte-for-byte', () => {
    const result = mintHlsToken({
      mediaId: vectors.mediaId,
      prefix: vectors.prefix,
      ttlSeconds: vectors.expiredExp - vectors.now,
      secret: vectors.secret,
      nowSeconds: vectors.now,
    });
    expect(result.token).toBe(vectors.expired);
  });

  it('mintHlsToken reproduces the shared "validDifferentPrefix" vector byte-for-byte', () => {
    const result = mintHlsToken({
      mediaId: vectors.otherMediaId,
      prefix: vectors.otherPrefix,
      ttlSeconds: vectors.validExp - vectors.now,
      secret: vectors.secret,
      nowSeconds: vectors.now,
    });
    expect(result.token).toBe(vectors.validDifferentPrefix);
  });

  it('mintHlsToken reproduces the shared "validNextGeneration" vector byte-for-byte', () => {
    const result = mintHlsToken({
      mediaId: vectors.mediaId,
      prefix: vectors.genNextPrefix,
      ttlSeconds: vectors.validExp - vectors.now,
      secret: vectors.secret,
      nowSeconds: vectors.now,
    });
    expect(result.token).toBe(vectors.validNextGeneration);
  });

  it('mintHlsToken with the WRONG secret reproduces the shared "wrongSecretToken" vector byte-for-byte (proving the Worker\'s rejection of it is a genuine cross-secret mismatch, not a fixture typo)', () => {
    const result = mintHlsToken({
      mediaId: vectors.mediaId,
      prefix: vectors.prefix,
      ttlSeconds: vectors.validExp - vectors.now,
      secret: vectors.wrongSecret,
      nowSeconds: vectors.now,
    });
    expect(result.token).toBe(vectors.wrongSecretToken);
  });

  it('the "tamperedSignature" vector differs from "valid" ONLY in its signature segment (same payload, one flipped trailing character)', () => {
    const [validPayload, validSig] = vectors.valid.split('.');
    const [tamperedPayload, tamperedSig] = vectors.tamperedSignature.split('.');
    expect(tamperedPayload).toBe(validPayload);
    expect(tamperedSig).not.toBe(validSig);
    expect(tamperedSig.length).toBe(validSig.length);
  });
});
