import { createHmac } from 'crypto';
import {
  derivePrefixFromMasterKey,
  HlsTokenPayloadV1,
  mintHlsToken,
} from './hls-playback-token.util';

function decodePayload(payloadSegment: string): HlsTokenPayloadV1 {
  return JSON.parse(
    Buffer.from(payloadSegment, 'base64url').toString('utf8'),
  ) as HlsTokenPayloadV1;
}

describe('mintHlsToken (Slice 11Q token v1)', () => {
  const secret = 'unit-test-only-synthetic-hls-secret';

  it('produces a token with exactly one "." separator', () => {
    const { token } = mintHlsToken({
      mediaId: 'video-abc',
      prefix: 'admin-media/video-abc/hls/v1-a1-uuid/',
      ttlSeconds: 3600,
      secret,
      nowSeconds: 1_000_000,
    });
    expect(token.split('.')).toHaveLength(2);
  });

  it('the signature segment is a genuine HMAC-SHA256 of the payload segment under the given secret', () => {
    const { token } = mintHlsToken({
      mediaId: 'video-abc',
      prefix: 'admin-media/video-abc/hls/v1-a1-uuid/',
      ttlSeconds: 3600,
      secret,
      nowSeconds: 1_000_000,
    });
    const [payloadSegment, sigSegment] = token.split('.');
    const expectedSig = createHmac('sha256', secret)
      .update(payloadSegment)
      .digest('base64url');
    expect(sigSegment).toBe(expectedSig);
  });

  it('the payload segment decodes to the exact v1 shape {v,m,p,e}', () => {
    const { token, exp } = mintHlsToken({
      mediaId: 'video-abc',
      prefix: 'admin-media/video-abc/hls/v1-a1-uuid/',
      ttlSeconds: 3600,
      secret,
      nowSeconds: 1_000_000,
    });
    const [payloadSegment] = token.split('.');
    const decoded = decodePayload(payloadSegment);
    expect(decoded).toEqual({
      v: 1,
      m: 'video-abc',
      p: 'admin-media/video-abc/hls/v1-a1-uuid/',
      e: exp,
    });
  });

  it('exp is exactly nowSeconds + ttlSeconds', () => {
    const result = mintHlsToken({
      mediaId: 'video-abc',
      prefix: 'admin-media/video-abc/hls/v1-a1-uuid/',
      ttlSeconds: 1800,
      secret,
      nowSeconds: 1_000_000,
    });
    expect(result.exp).toBe(1_001_800);
    expect(result.expiresAt).toBe(new Date(1_001_800 * 1000).toISOString());
  });

  it('defaults nowSeconds to the real wall clock when not supplied', () => {
    const before = Math.floor(Date.now() / 1000);
    const result = mintHlsToken({
      mediaId: 'video-abc',
      prefix: 'admin-media/video-abc/hls/v1-a1-uuid/',
      ttlSeconds: 60,
      secret,
    });
    const after = Math.floor(Date.now() / 1000);
    expect(result.exp).toBeGreaterThanOrEqual(before + 60);
    expect(result.exp).toBeLessThanOrEqual(after + 60);
  });

  it('two mints for the same media at different prefixes never collide', () => {
    const first = mintHlsToken({
      mediaId: 'video-abc',
      prefix: 'admin-media/video-abc/hls/v1-a1-uuid/',
      ttlSeconds: 3600,
      secret,
      nowSeconds: 1_000_000,
    });
    const second = mintHlsToken({
      mediaId: 'video-abc',
      prefix: 'admin-media/video-abc/hls/v2-a1-uuid/',
      ttlSeconds: 3600,
      secret,
      nowSeconds: 1_000_000,
    });
    expect(first.token).not.toBe(second.token);
  });

  it('never includes a userId/uid field in the minted payload (frozen decision — content/version-bound only)', () => {
    const { token } = mintHlsToken({
      mediaId: 'video-abc',
      prefix: 'admin-media/video-abc/hls/v1-a1-uuid/',
      ttlSeconds: 3600,
      secret,
      nowSeconds: 1_000_000,
    });
    const [payloadSegment] = token.split('.');
    const decoded = decodePayload(payloadSegment);
    expect(Object.keys(decoded).sort()).toEqual(['e', 'm', 'p', 'v']);
  });
});

describe('derivePrefixFromMasterKey', () => {
  it('derives the generation prefix from a well-formed hlsMasterKey', () => {
    expect(
      derivePrefixFromMasterKey(
        'video-abc',
        'admin-media/video-abc/hls/v3-a1-some-uuid/master.m3u8',
      ),
    ).toBe('admin-media/video-abc/hls/v3-a1-some-uuid/');
  });

  it('returns null for a null hlsMasterKey', () => {
    expect(derivePrefixFromMasterKey('video-abc', null)).toBeNull();
  });

  it('returns null when the derived prefix does not belong to the given mediaId (cross-media mismatch guard)', () => {
    expect(
      derivePrefixFromMasterKey(
        'video-abc',
        'admin-media/video-OTHER/hls/v3-a1-some-uuid/master.m3u8',
      ),
    ).toBeNull();
  });

  it('returns null for a malformed hlsMasterKey with no "/" at all', () => {
    expect(derivePrefixFromMasterKey('video-abc', 'master.m3u8')).toBeNull();
  });
});
