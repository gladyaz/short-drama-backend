import { describe, expect, it } from 'vitest';
import { verify } from '../src/token';
import vectors from './token-vectors.json';

describe('token.verify (Slice 11Q token v1)', () => {
  it('[TEST 1] accepts a validly-signed, unexpired token and returns its claims', async () => {
    const result = await verify(vectors.valid, vectors.secret, vectors.now);
    expect(result).toEqual({
      mediaId: vectors.mediaId,
      prefix: vectors.prefix,
      exp: vectors.validExp,
    });
  });

  it('[TEST 2] rejects a tampered signature', async () => {
    expect(
      await verify(vectors.tamperedSignature, vectors.secret, vectors.now),
    ).toBeNull();
  });

  it('[TEST 2b] rejects a token signed with the wrong secret entirely', async () => {
    expect(
      await verify(vectors.wrongSecretToken, vectors.secret, vectors.now),
    ).toBeNull();
  });

  it('[TEST 3] rejects an expired token', async () => {
    expect(await verify(vectors.expired, vectors.secret, vectors.now)).toBeNull();
  });

  it('rejects a token at the exact expiry boundary (exp === now) — fail closed, not fail open', async () => {
    expect(
      await verify(vectors.valid, vectors.secret, vectors.validExp),
    ).toBeNull();
  });

  it('a validly-signed token for a DIFFERENT mediaId/prefix still verifies on its own terms — prefix/media containment is the HANDLER\'s job (path.ts + index.ts), not verify()\'s', async () => {
    const result = await verify(
      vectors.validDifferentPrefix,
      vectors.secret,
      vectors.now,
    );
    expect(result).toEqual({
      mediaId: vectors.otherMediaId,
      prefix: vectors.otherPrefix,
      exp: vectors.validExp,
    });
  });

  it('a validly-signed token for the NEXT generation of the same media verifies on its own terms too', async () => {
    const result = await verify(
      vectors.validNextGeneration,
      vectors.secret,
      vectors.now,
    );
    expect(result).toEqual({
      mediaId: vectors.mediaId,
      prefix: vectors.genNextPrefix,
      exp: vectors.validExp,
    });
  });

  it('rejects an empty string', async () => {
    expect(await verify('', vectors.secret, vectors.now)).toBeNull();
  });

  it('rejects a token with no "." separator', async () => {
    expect(await verify('not-a-token-at-all', vectors.secret, vectors.now)).toBeNull();
  });

  it('rejects a token with more than one "." separator', async () => {
    expect(
      await verify(`${vectors.valid}.extra`, vectors.secret, vectors.now),
    ).toBeNull();
  });

  it('rejects non-base64url characters in either segment', async () => {
    expect(await verify('not base64url!.alsobad!', vectors.secret, vectors.now)).toBeNull();
  });

  it('rejects standard base64 (with padding "=") rather than lenient-decoding it', async () => {
    expect(await verify('YWJj=.ZGVm=', vectors.secret, vectors.now)).toBeNull();
  });

  it('rejects a payload that decodes to invalid JSON', async () => {
    const garbagePayload = Buffer.from('not-json', 'utf8').toString('base64url');
    expect(
      await verify(`${garbagePayload}.${'a'.repeat(8)}`, vectors.secret, vectors.now),
    ).toBeNull();
  });

  it('rejects a payload with a missing required field (e.g. no "e")', async () => {
    const payload = { v: 1, m: vectors.mediaId, p: vectors.prefix };
    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString(
      'base64url',
    );
    expect(
      await verify(`${payloadB64}.${'a'.repeat(8)}`, vectors.secret, vectors.now),
    ).toBeNull();
  });

  it('rejects a payload with an extra, unexpected field', async () => {
    const payload = {
      v: 1,
      m: vectors.mediaId,
      p: vectors.prefix,
      e: vectors.validExp,
      extra: 'unexpected',
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString(
      'base64url',
    );
    expect(
      await verify(`${payloadB64}.${'a'.repeat(8)}`, vectors.secret, vectors.now),
    ).toBeNull();
  });

  it('rejects v !== 1', async () => {
    const payload = { v: 2, m: vectors.mediaId, p: vectors.prefix, e: vectors.validExp };
    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString(
      'base64url',
    );
    expect(
      await verify(`${payloadB64}.${'a'.repeat(8)}`, vectors.secret, vectors.now),
    ).toBeNull();
  });
});
