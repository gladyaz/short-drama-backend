import {
  decodeGoogleIdToken,
  GoogleTokenRejected,
  validateGoogleClaims,
  type GoogleIdTokenClaims,
} from './google-id-token.util';
import {
  GOOGLE_CLOCK_SKEW_MS,
  MAX_GOOGLE_ID_TOKEN_LENGTH,
} from '../auth-identity.constants';

/**
 * PHASE 10B. The claim rules below are where the security-relevant decisions
 * of Google verification live, so they are tested exhaustively and WITHOUT
 * any network involvement — that separation is the reason
 * `google-id-token.util.ts` exists as its own module (the RSA signature
 * check and the JWKS fetch are covered in `google-oidc.verifier.spec.ts`,
 * against real generated keys).
 *
 * Every test states the attack or mistake it prevents, because a claim
 * validator whose tests only assert "returns the subject" is indistinguishable
 * from one that returns the subject unconditionally.
 */

const CLIENT_ID = 'client-a.apps.googleusercontent.com';
const OTHER_CLIENT_ID = 'client-b.apps.googleusercontent.com';
const NOW = new Date('2026-08-20T12:00:00.000Z');

function secondsFromNow(offsetMs: number): number {
  return Math.floor((NOW.getTime() + offsetMs) / 1000);
}

function baseClaims(overrides: GoogleIdTokenClaims = {}): GoogleIdTokenClaims {
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: '1234567890',
    exp: secondsFromNow(60 * 60 * 1000),
    iat: secondsFromNow(-60 * 1000),
    email: 'Person@Example.com',
    email_verified: true,
    name: 'A Person',
    ...overrides,
  };
}

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function compactJws(
  header: object,
  payload: object,
  signature = 'AAAA',
): string {
  return `${base64url(header)}.${base64url(payload)}.${signature}`;
}

function expectRejection(
  run: () => unknown,
  reason: GoogleTokenRejected['reason'],
): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(GoogleTokenRejected);
    expect((error as GoogleTokenRejected).reason).toBe(reason);
    return;
  }
  throw new Error(
    `Expected rejection with reason "${reason}", but none was thrown.`,
  );
}

describe('decodeGoogleIdToken', () => {
  it('decodes a well-formed RS256 compact JWS without granting it any trust', () => {
    const decoded = decodeGoogleIdToken(
      compactJws({ alg: 'RS256', kid: 'key-1' }, baseClaims()),
    );

    expect(decoded.header.alg).toBe('RS256');
    expect(decoded.header.kid).toBe('key-1');
    expect(decoded.claims.sub).toBe('1234567890');
    // The signing input must be the EXACT `<header>.<payload>` bytes, not a
    // re-serialization — re-encoding would produce different bytes and every
    // real signature would then fail to verify.
    expect(decoded.signingInput.split('.')).toHaveLength(2);
  });

  it('rejects alg:none — the classic unsigned-token forgery', () => {
    expectRejection(
      () => decodeGoogleIdToken(compactJws({ alg: 'none' }, baseClaims())),
      'unsupported_algorithm',
    );
  });

  it('rejects a symmetric algorithm — the HS256 key-confusion attack', () => {
    // Google's RSA signing key is PUBLIC. A verifier that honoured the
    // token's own `alg` would treat that public key as an HMAC secret, and
    // anyone could forge a token with it.
    expectRejection(
      () =>
        decodeGoogleIdToken(
          compactJws({ alg: 'HS256', kid: 'key-1' }, baseClaims()),
        ),
      'unsupported_algorithm',
    );
  });

  it('rejects structurally invalid input without attempting to interpret it', () => {
    expectRejection(() => decodeGoogleIdToken('not-a-jwt'), 'malformed');
    expectRejection(() => decodeGoogleIdToken('a.b'), 'malformed');
    expectRejection(() => decodeGoogleIdToken('a.b.c.d'), 'malformed');
    expectRejection(() => decodeGoogleIdToken(''), 'malformed');
    expectRejection(() => decodeGoogleIdToken(undefined), 'malformed');
    expectRejection(() => decodeGoogleIdToken(12345), 'malformed');
  });

  it('rejects an empty segment', () => {
    expectRejection(
      () => decodeGoogleIdToken(`${base64url({ alg: 'RS256' })}..AAAA`),
      'malformed',
    );
  });

  it('rejects a payload that is not a JSON object', () => {
    const arrayPayload = `${base64url({ alg: 'RS256', kid: 'k' })}.${Buffer.from(
      '[1,2,3]',
    ).toString('base64url')}.AAAA`;

    expectRejection(() => decodeGoogleIdToken(arrayPayload), 'malformed');
  });

  it('rejects an oversized token BEFORE parsing, bounding unauthenticated CPU cost', () => {
    const oversized = 'a'.repeat(MAX_GOOGLE_ID_TOKEN_LENGTH + 1);

    expectRejection(() => decodeGoogleIdToken(oversized), 'malformed');
  });
});

describe('validateGoogleClaims', () => {
  it('accepts both issuer spellings Google actually emits', () => {
    for (const iss of ['accounts.google.com', 'https://accounts.google.com']) {
      expect(
        validateGoogleClaims(baseClaims({ iss }), [CLIENT_ID], NOW).subject,
      ).toBe('1234567890');
    }
  });

  it('rejects a look-alike issuer — the allowlist is exact, never a suffix match', () => {
    // `accounts.google.com.evil.example` would satisfy an
    // `endsWith('google.com')` check.
    expectRejection(
      () =>
        validateGoogleClaims(
          baseClaims({ iss: 'https://accounts.google.com.evil.example' }),
          [CLIENT_ID],
          NOW,
        ),
      'bad_issuer',
    );
  });

  it('rejects a token minted for a DIFFERENT application', () => {
    // Without this check, any Google-integrated app in the world could mint a
    // token its users would happily hand over, and it would sign them in here.
    expectRejection(
      () =>
        validateGoogleClaims(
          baseClaims({ aud: 'someone-elses-app.apps.googleusercontent.com' }),
          [CLIENT_ID],
          NOW,
        ),
      'bad_audience',
    );
  });

  it('accepts any client id in the configured allowlist, so one backend can serve several platforms', () => {
    expect(
      validateGoogleClaims(
        baseClaims({ aud: OTHER_CLIENT_ID }),
        [CLIENT_ID, OTHER_CLIENT_ID],
        NOW,
      ).subject,
    ).toBe('1234567890');
  });

  it('accepts an array-valued aud when one entry matches, per the JWT specification', () => {
    expect(
      validateGoogleClaims(
        baseClaims({ aud: ['unrelated', CLIENT_ID] }),
        [CLIENT_ID],
        NOW,
      ).subject,
    ).toBe('1234567890');
  });

  it('rejects EVERY token when the audience allowlist is empty, rather than accepting any', () => {
    // Fail-closed: an unconfigured verifier must reject, never wave through.
    expectRejection(
      () => validateGoogleClaims(baseClaims(), [], NOW),
      'bad_audience',
    );
  });

  it('rejects an expired token', () => {
    expectRejection(
      () =>
        validateGoogleClaims(
          baseClaims({ exp: secondsFromNow(-GOOGLE_CLOCK_SKEW_MS - 1000) }),
          [CLIENT_ID],
          NOW,
        ),
      'expired',
    );
  });

  it('tolerates a token that expired within the allowed clock skew', () => {
    // Without symmetric skew tolerance, a server whose clock runs a few
    // seconds fast rejects freshly issued, perfectly valid tokens.
    expect(
      validateGoogleClaims(
        baseClaims({ exp: secondsFromNow(-1000) }),
        [CLIENT_ID],
        NOW,
      ).subject,
    ).toBe('1234567890');
  });

  it('rejects a token issued in the future', () => {
    expectRejection(
      () =>
        validateGoogleClaims(
          baseClaims({ iat: secondsFromNow(GOOGLE_CLOCK_SKEW_MS + 60_000) }),
          [CLIENT_ID],
          NOW,
        ),
      'not_yet_valid',
    );
  });

  it('rejects a token not yet valid per nbf', () => {
    expectRejection(
      () =>
        validateGoogleClaims(
          baseClaims({ nbf: secondsFromNow(GOOGLE_CLOCK_SKEW_MS + 60_000) }),
          [CLIENT_ID],
          NOW,
        ),
      'not_yet_valid',
    );
  });

  it('rejects a token with no usable subject — the identity key itself', () => {
    expectRejection(
      () =>
        validateGoogleClaims(baseClaims({ sub: undefined }), [CLIENT_ID], NOW),
      'missing_subject',
    );
    expectRejection(
      () => validateGoogleClaims(baseClaims({ sub: '' }), [CLIENT_ID], NOW),
      'missing_subject',
    );
    expectRejection(
      () => validateGoogleClaims(baseClaims({ sub: 12345 }), [CLIENT_ID], NOW),
      'missing_subject',
    );
  });

  it('rejects a non-numeric exp rather than treating it as absent', () => {
    expectRejection(
      () => validateGoogleClaims(baseClaims({ exp: 'soon' }), [CLIENT_ID], NOW),
      'malformed',
    );
    expectRejection(
      () =>
        validateGoogleClaims(baseClaims({ exp: undefined }), [CLIENT_ID], NOW),
      'malformed',
    );
  });

  it('lowercases a verified email so it can be compared against stored identities', () => {
    expect(validateGoogleClaims(baseClaims(), [CLIENT_ID], NOW).email).toBe(
      'person@example.com',
    );
  });

  it('DROPS an unverified email — the claim that decides account-collision outcomes must fail closed', () => {
    // An unverified address is not evidence the caller controls it. Passing it
    // through would let it either unlock an existing account or be recorded as
    // this account's email.
    expect(
      validateGoogleClaims(
        baseClaims({ email_verified: false }),
        [CLIENT_ID],
        NOW,
      ).email,
    ).toBeUndefined();
  });

  it('treats a MISSING email_verified as unverified, never as true', () => {
    expect(
      validateGoogleClaims(
        baseClaims({ email_verified: undefined }),
        [CLIENT_ID],
        NOW,
      ).email,
    ).toBeUndefined();
  });

  it('accepts the string "true" for email_verified, which some Google flows emit', () => {
    expect(
      validateGoogleClaims(
        baseClaims({ email_verified: 'true' }),
        [CLIENT_ID],
        NOW,
      ).email,
    ).toBe('person@example.com');
  });

  it('does not accept other truthy-looking email_verified values', () => {
    for (const value of [1, 'yes', 'TRUE', {}]) {
      expect(
        validateGoogleClaims(
          baseClaims({ email_verified: value }),
          [CLIENT_ID],
          NOW,
        ).email,
      ).toBeUndefined();
    }
  });

  it('returns a trimmed display name, or none at all', () => {
    expect(
      validateGoogleClaims(
        baseClaims({ name: '  A Person  ' }),
        [CLIENT_ID],
        NOW,
      ).displayName,
    ).toBe('A Person');
    expect(
      validateGoogleClaims(baseClaims({ name: '   ' }), [CLIENT_ID], NOW)
        .displayName,
    ).toBeUndefined();
    expect(
      validateGoogleClaims(baseClaims({ name: 42 }), [CLIENT_ID], NOW)
        .displayName,
    ).toBeUndefined();
  });
});
