import { createSign, generateKeyPairSync, type KeyObject } from 'crypto';
import { GoogleTokenRejected } from './google-id-token.util';
import {
  GoogleOidcIdentityVerifier,
  type JwksFetchResult,
} from './google-oidc.verifier';
import { GOOGLE_JWKS_CACHE_MAX_MS } from '../auth-identity.constants';

/**
 * PHASE 10B — the RSA signature half of Google ID-token verification,
 * exercised against REAL, freshly generated RSA key pairs and REAL RS256
 * signatures. Nothing is mocked except the JWKS TRANSPORT, which is injected
 * — so these tests prove the actual cryptography works and that a token
 * signed by the wrong key is genuinely rejected, rather than proving a stub
 * returns what a stub was told to return.
 *
 * NO NETWORK REQUEST IS MADE. `fetchJwks` is supplied for every test, so this
 * suite cannot reach Google (or anywhere else) regardless of environment.
 */

const CLIENT_ID = 'client-a.apps.googleusercontent.com';
const NOW = new Date('2026-08-20T12:00:00.000Z');

interface TestKey {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function makeKey(kid: string): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  return {
    kid,
    privateKey,
    jwk: {
      ...publicKey.export({ format: 'jwk' }),
      kid,
      alg: 'RS256',
      use: 'sig',
    },
  };
}

function signIdToken(
  key: TestKey,
  claimOverrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
): string {
  const header = { alg: 'RS256', kid: key.kid, typ: 'JWT', ...headerOverrides };
  const claims = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: 'google-subject-1',
    exp: Math.floor((NOW.getTime() + 3_600_000) / 1000),
    iat: Math.floor((NOW.getTime() - 60_000) / 1000),
    email: 'person@example.com',
    email_verified: true,
    name: 'A Person',
    ...claimOverrides,
  };

  const signingInput = `${Buffer.from(JSON.stringify(header)).toString(
    'base64url',
  )}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;

  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();

  return `${signingInput}.${signer.sign(key.privateKey).toString('base64url')}`;
}

async function expectRejection(
  run: () => Promise<unknown>,
  reason: GoogleTokenRejected['reason'],
): Promise<void> {
  await expect(run()).rejects.toMatchObject({ reason });
}

describe('GoogleOidcIdentityVerifier', () => {
  let key: TestKey;
  let fetchCalls: number;

  beforeEach(() => {
    key = makeKey('key-1');
    fetchCalls = 0;
  });

  function makeVerifier(
    result: JwksFetchResult | (() => JwksFetchResult),
    now: Date | (() => Date) = NOW,
  ): GoogleOidcIdentityVerifier {
    return new GoogleOidcIdentityVerifier({
      allowedAudiences: [CLIENT_ID],
      fetchJwks: () => {
        fetchCalls += 1;
        return Promise.resolve(
          typeof result === 'function' ? result() : result,
        );
      },
      now: typeof now === 'function' ? now : () => now,
    });
  }

  it('verifies a genuine RS256 signature and returns the claims that survived validation', async () => {
    const verifier = makeVerifier({ keys: [key.jwk] });

    await expect(verifier.verifyIdToken(signIdToken(key))).resolves.toEqual({
      subject: 'google-subject-1',
      email: 'person@example.com',
      displayName: 'A Person',
    });
  });

  it('REJECTS a token signed by a different key — the whole point of signature verification', async () => {
    // The token is otherwise perfect: right issuer, right audience, unexpired,
    // and it names a `kid` the key set contains. Only the signature is wrong.
    const attackerKey = { ...makeKey('key-1'), kid: 'key-1' };
    const verifier = makeVerifier({ keys: [key.jwk] });

    await expectRejection(
      () => verifier.verifyIdToken(signIdToken(attackerKey)),
      'bad_signature',
    );
  });

  it('REJECTS a token whose payload was tampered with after signing', async () => {
    const token = signIdToken(key);
    const [header, , signature] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: CLIENT_ID,
        sub: 'victim-subject',
        exp: Math.floor((NOW.getTime() + 3_600_000) / 1000),
      }),
    ).toString('base64url');

    const verifier = makeVerifier({ keys: [key.jwk] });

    await expectRejection(
      () => verifier.verifyIdToken(`${header}.${forgedPayload}.${signature}`),
      'bad_signature',
    );
  });

  it('rejects a token with no kid rather than trying every published key', async () => {
    const verifier = makeVerifier({ keys: [key.jwk] });

    await expectRejection(
      () => verifier.verifyIdToken(signIdToken(key, {}, { kid: undefined })),
      'missing_kid',
    );
  });

  it('rejects a token naming a kid Google does not publish', async () => {
    const verifier = makeVerifier({ keys: [key.jwk] });
    const unknownKey = makeKey('key-unknown');

    await expectRejection(
      () => verifier.verifyIdToken(signIdToken(unknownKey)),
      'unknown_key',
    );
  });

  it('validates claims only AFTER the signature verifies', async () => {
    // A token with a wrong audience AND a wrong signature must report the
    // signature failure: claims read off an unverified token are worthless,
    // so the signature gate must come first.
    const attackerKey = { ...makeKey('key-1'), kid: 'key-1' };
    const verifier = makeVerifier({ keys: [key.jwk] });

    await expectRejection(
      () => verifier.verifyIdToken(signIdToken(attackerKey, { aud: 'wrong' })),
      'bad_signature',
    );
  });

  it('rejects a correctly signed token whose audience is not allowlisted', async () => {
    const verifier = makeVerifier({ keys: [key.jwk] });

    await expectRejection(
      () => verifier.verifyIdToken(signIdToken(key, { aud: 'other-app' })),
      'bad_audience',
    );
  });

  it('rejects a correctly signed but expired token', async () => {
    const verifier = makeVerifier({ keys: [key.jwk] });

    await expectRejection(
      () =>
        verifier.verifyIdToken(
          signIdToken(key, {
            exp: Math.floor((NOW.getTime() - 600_000) / 1000),
          }),
        ),
      'expired',
    );
  });

  it('caches the key set instead of fetching per request', async () => {
    const verifier = makeVerifier({ keys: [key.jwk] });

    await verifier.verifyIdToken(signIdToken(key));
    await verifier.verifyIdToken(signIdToken(key));
    await verifier.verifyIdToken(signIdToken(key));

    expect(fetchCalls).toBe(1);
  });

  it('re-fetches once when a token names a kid the cache does not hold, so key rotation is transparent', async () => {
    const rotatedKey = makeKey('key-2');
    let published = [key.jwk];
    const verifier = makeVerifier(() => ({ keys: published }));

    await verifier.verifyIdToken(signIdToken(key));
    expect(fetchCalls).toBe(1);

    published = [key.jwk, rotatedKey.jwk];

    await expect(
      verifier.verifyIdToken(signIdToken(rotatedKey)),
    ).resolves.toMatchObject({ subject: 'google-subject-1' });
    expect(fetchCalls).toBe(2);
  });

  it('bounds an unknown-kid attacker to ONE refresh per request, never a fetch loop', async () => {
    const verifier = makeVerifier({ keys: [key.jwk] });
    const unknownKey = makeKey('nope');

    await expectRejection(
      () => verifier.verifyIdToken(signIdToken(unknownKey)),
      'unknown_key',
    );
    expect(fetchCalls).toBe(1);
  });

  it('expires the cache after the advertised max-age', async () => {
    let clock = NOW.getTime();
    const verifier = makeVerifier(
      { keys: [key.jwk], maxAgeMs: 60_000 },
      () => new Date(clock),
    );

    await verifier.verifyIdToken(signIdToken(key));
    expect(fetchCalls).toBe(1);

    clock += 61_000;
    await verifier.verifyIdToken(signIdToken(key));
    expect(fetchCalls).toBe(2);
  });

  it('CAPS an advertised max-age, so a mis-set or hostile header cannot pin a stale key set forever', async () => {
    let clock = NOW.getTime();
    const verifier = makeVerifier(
      { keys: [key.jwk], maxAgeMs: 365 * 24 * 60 * 60 * 1000 },
      () => new Date(clock),
    );

    await verifier.verifyIdToken(signIdToken(key));
    expect(fetchCalls).toBe(1);

    clock += GOOGLE_JWKS_CACHE_MAX_MS + 1000;
    await verifier.verifyIdToken(signIdToken(key));
    expect(fetchCalls).toBe(2);
  });

  it('never caches an empty key set, so one bad response is not a cache-lifetime outage', async () => {
    let published: Record<string, unknown>[] = [];
    const verifier = makeVerifier(() => ({ keys: published }));

    await expectRejection(
      () => verifier.verifyIdToken(signIdToken(key)),
      'unknown_key',
    );

    published = [key.jwk];

    await expect(
      verifier.verifyIdToken(signIdToken(key)),
    ).resolves.toMatchObject({
      subject: 'google-subject-1',
    });
  });

  it('ignores unusable JWKS entries without discarding the usable ones', async () => {
    const verifier = makeVerifier({
      keys: [
        { kid: 'ec-key', kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
        { kid: 'enc-key', kty: 'RSA', use: 'enc', n: 'a', e: 'AQAB' },
        { kid: 'no-kid', kty: 'RSA', n: 'a', e: 'AQAB' },
        key.jwk,
      ],
    });

    await expect(
      verifier.verifyIdToken(signIdToken(key)),
    ).resolves.toMatchObject({
      subject: 'google-subject-1',
    });
  });

  it('de-duplicates concurrent cold-cache fetches instead of stampeding Google', async () => {
    const verifier = makeVerifier({ keys: [key.jwk] });

    await Promise.all([
      verifier.verifyIdToken(signIdToken(key)),
      verifier.verifyIdToken(signIdToken(key)),
      verifier.verifyIdToken(signIdToken(key)),
      verifier.verifyIdToken(signIdToken(key)),
    ]);

    expect(fetchCalls).toBe(1);
  });

  it('refuses to be constructed with no audience allowlist, rather than accepting every token', () => {
    expect(
      () => new GoogleOidcIdentityVerifier({ allowedAudiences: [] }),
    ).toThrow(/at least one allowed audience/i);
  });
});
