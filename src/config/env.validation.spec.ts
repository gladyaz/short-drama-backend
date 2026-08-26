import { REQUIRED_R2_KEYS, validateEnv } from './env.validation';

/** Shallow copy of `config` with `key` removed — avoids unused-binding lint noise from destructure-to-omit. */
function omitKey(
  config: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const copy = { ...config };
  delete copy[key];
  return copy;
}

const VALID_CONFIG: Record<string, unknown> = {
  PORT: '3000',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  STORAGE_ROOT: process.cwd(),
  CORS_ORIGINS: 'http://localhost:8081',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_ACCESS_SECRET: 'test-access-secret',
  JWT_REFRESH_SECRET: 'test-refresh-secret',
  AUTH_AUDIT_IP_HASH_SECRET: 'test-auth-audit-ip-hash-secret',
};

/**
 * Phase 12, work unit 12A-B3: `AUTH_AUDIT_IP_HASH_SECRET` (DECISIONS.md
 * "Phase 12 ... approved..." entry, decision 6) is required unconditionally,
 * matching the existing JWT-secret required-key precedent above.
 */
describe('validateEnv — AUTH_AUDIT_IP_HASH_SECRET (Phase 12, 12A-B3)', () => {
  it('passes when AUTH_AUDIT_IP_HASH_SECRET is present', () => {
    expect(() => validateEnv({ ...VALID_CONFIG })).not.toThrow();
  });

  it('throws naming the missing variable when AUTH_AUDIT_IP_HASH_SECRET is absent', () => {
    const configMissingSecret = omitKey(
      VALID_CONFIG,
      'AUTH_AUDIT_IP_HASH_SECRET',
    );

    expect(() => validateEnv(configMissingSecret)).toThrow(
      /Missing required environment variable: AUTH_AUDIT_IP_HASH_SECRET/,
    );
  });
});

/**
 * Phase 10, work unit 10-B6 originally covered the production fail-loud
 * check added alongside `DEV_TOOLS_ENABLED` (10-B5). Phase 12, work unit
 * 12D-B2 replaced that check's exact-string denylist
 * (`NODE_ENV === 'production'`) with a fail-closed ALLOWLIST after an
 * independent security review found it HIGH: an unset, empty, misspelled, or
 * differently-cased `NODE_ENV` silently passed the old check, and the same
 * flag also gates `/dev/admin/*`'s self-service admin-role grant — a
 * privilege-escalation path, not merely the dev-only entitlement
 * grant/revoke routes this check was first written for.
 *
 * The matrix below exercises every `DEV_TOOLS_ENABLED` (true/false) ×
 * `NODE_ENV` (unset / empty / development / test / production / Production /
 * arbitrary junk) combination explicitly, per that review's requirement.
 */
describe('validateEnv — DEV_TOOLS_ENABLED / NODE_ENV interaction (Phase 12, 12D-B2)', () => {
  /** `nodeEnv: undefined` means the key is OMITTED from the config entirely — genuinely unset, not the string `"undefined"`. */
  const NODE_ENV_CASES: Array<{ label: string; nodeEnv: string | undefined }> =
    [
      { label: 'unset', nodeEnv: undefined },
      { label: 'empty string', nodeEnv: '' },
      { label: 'development', nodeEnv: 'development' },
      { label: 'test', nodeEnv: 'test' },
      { label: 'production', nodeEnv: 'production' },
      { label: 'Production (wrong case)', nodeEnv: 'Production' },
      { label: 'arbitrary junk', nodeEnv: 'not-a-real-environment' },
    ];

  function buildConfig(
    devToolsEnabled: 'true' | 'false',
    nodeEnv: string | undefined,
  ): Record<string, unknown> {
    const config: Record<string, unknown> = {
      ...VALID_CONFIG,
      DEV_TOOLS_ENABLED: devToolsEnabled,
      // Production additionally requires an https PUBLIC_BASE_URL (see the
      // "PUBLIC_BASE_URL https in production" block at the end of this file).
      // VALID_CONFIG's http://localhost:3000 baseline is not production-valid,
      // and this block's subject is the DEV_TOOLS_ENABLED x NODE_ENV matrix —
      // so it uses a base URL that is valid under EVERY NODE_ENV, keeping the
      // one variable under test the only thing that decides the outcome.
      PUBLIC_BASE_URL: 'https://api.example.com',
      // Same reasoning for CORS: VALID_CONFIG's http://localhost:8081 is a
      // legitimate DEV origin that production rejects. Empty is valid under
      // every NODE_ENV (and is the correct mobile-only answer), so it keeps
      // NODE_ENV x DEV_TOOLS_ENABLED the only variables under test here.
      CORS_ORIGINS: '',
    };
    if (nodeEnv !== undefined) {
      config.NODE_ENV = nodeEnv;
    }
    return config;
  }

  describe('DEV_TOOLS_ENABLED=false — boots under every NODE_ENV, including unset', () => {
    it.each(NODE_ENV_CASES)('passes when NODE_ENV is $label', ({ nodeEnv }) => {
      expect(() => validateEnv(buildConfig('false', nodeEnv))).not.toThrow();
    });
  });

  describe('DEV_TOOLS_ENABLED=true — only an explicit development/test NODE_ENV boots', () => {
    it.each([
      { label: 'development', nodeEnv: 'development' },
      { label: 'test', nodeEnv: 'test' },
    ])('passes when NODE_ENV is $label', ({ nodeEnv }) => {
      expect(() => validateEnv(buildConfig('true', nodeEnv))).not.toThrow();
    });

    it.each([
      { label: 'unset', nodeEnv: undefined },
      { label: 'empty string', nodeEnv: '' },
      { label: 'production', nodeEnv: 'production' },
      { label: 'Production (wrong case)', nodeEnv: 'Production' },
      { label: 'arbitrary junk', nodeEnv: 'not-a-real-environment' },
    ])('throws naming the problem when NODE_ENV is $label', ({ nodeEnv }) => {
      expect(() => validateEnv(buildConfig('true', nodeEnv))).toThrow(
        /Refusing to boot with DEV_TOOLS_ENABLED=true/,
      );
    });

    it('names the actual (unsafe) NODE_ENV value in the thrown message, never a generic "invalid" message', () => {
      expect(() =>
        validateEnv(buildConfig('true', 'not-a-real-environment')),
      ).toThrow(/NODE_ENV="not-a-real-environment"/);
    });

    it('reports NODE_ENV=null (not the string "undefined") when the key is genuinely absent', () => {
      expect(() => validateEnv(buildConfig('true', undefined))).toThrow(
        /NODE_ENV=null/,
      );
    });

    it('still fails loudly for the original 10-B5 production case (regression guard)', () => {
      expect(() => validateEnv(buildConfig('true', 'production'))).toThrow(
        /DEV_TOOLS_ENABLED=true/,
      );
    });
  });
});

/**
 * Phase 11, work unit 11G-3: `STORAGE_DRIVER` feature flag + conditional
 * `OBJECT_STORAGE_*` env-var-NAME validation. All tests here are entirely
 * in-memory (a plain object passed to `validateEnv`); no network call, no
 * real filesystem access beyond the existing `STORAGE_ROOT` check shared
 * with `VALID_CONFIG`, and only dummy placeholder strings are used — never
 * real credentials.
 */
describe('validateEnv — STORAGE_DRIVER (Phase 11, 11G-3)', () => {
  const VALID_R2_CONFIG: Record<string, unknown> = {
    ...VALID_CONFIG,
    STORAGE_DRIVER: 'r2',
    OBJECT_STORAGE_ENDPOINT: 'https://example.invalid',
    OBJECT_STORAGE_REGION: 'auto',
    OBJECT_STORAGE_BUCKET: 'test-bucket',
    OBJECT_STORAGE_ACCESS_KEY_ID: 'test-access-key-id',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'test-secret-access-key',
    OBJECT_STORAGE_PUBLIC_BASE_URL: 'https://media.example.invalid',
  };

  it('resolves to local and requires only STORAGE_ROOT when STORAGE_DRIVER is unset', () => {
    expect(() => validateEnv({ ...VALID_CONFIG })).not.toThrow();
  });

  it('treats STORAGE_DRIVER=local the same as unset — OBJECT_STORAGE_* absent is fine', () => {
    expect(() =>
      validateEnv({ ...VALID_CONFIG, STORAGE_DRIVER: 'local' }),
    ).not.toThrow();
  });

  it('passes in r2 mode when every required OBJECT_STORAGE_* name is present (dummy values, no network)', () => {
    expect(() => validateEnv({ ...VALID_R2_CONFIG })).not.toThrow();
  });

  it('throws naming the missing variable when a required OBJECT_STORAGE_* var is absent in r2 mode', () => {
    const configMissingSecret = omitKey(
      VALID_R2_CONFIG,
      'OBJECT_STORAGE_SECRET_ACCESS_KEY',
    );

    expect(() => validateEnv(configMissingSecret)).toThrow(
      /Missing required environment variable: OBJECT_STORAGE_SECRET_ACCESS_KEY/,
    );
  });

  it('never echoes a credential value in the missing-variable error message', () => {
    const configMissingBucket = omitKey(
      {
        ...VALID_R2_CONFIG,
        OBJECT_STORAGE_ACCESS_KEY_ID: 'super-secret-value-should-not-leak',
      },
      'OBJECT_STORAGE_BUCKET',
    );

    let caught: Error | undefined;
    try {
      validateEnv(configMissingBucket);
    } catch (error) {
      caught = error as Error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).not.toContain('super-secret-value-should-not-leak');
    expect(caught?.message).toContain('OBJECT_STORAGE_BUCKET');
  });

  it('rejects a malformed OBJECT_STORAGE_ENDPOINT in r2 mode (shape check only, no network)', () => {
    expect(() =>
      validateEnv({
        ...VALID_R2_CONFIG,
        OBJECT_STORAGE_ENDPOINT: 'not-a-valid-url',
      }),
    ).toThrow(/OBJECT_STORAGE_ENDPOINT must be a valid absolute http\(s\) URL/);
  });

  it('rejects an invalid STORAGE_DRIVER value', () => {
    expect(() =>
      validateEnv({ ...VALID_CONFIG, STORAGE_DRIVER: 's3' }),
    ).toThrow(/Invalid STORAGE_DRIVER: "s3"/);

    expect(() =>
      validateEnv({ ...VALID_CONFIG, STORAGE_DRIVER: 'foo' }),
    ).toThrow(/Invalid STORAGE_DRIVER: "foo"/);
  });
});

/**
 * Phase 11, work unit 11H-B1 / 11H-T1: `OBJECT_STORAGE_PUBLIC_BASE_URL` is
 * REMOVED from `REQUIRED_R2_KEYS` — it is now optional even in `r2` mode.
 * This is the dedicated non-vacuous regression coverage for that change:
 * local mode with zero R2 vars; the **private** R2 case this slice exists
 * for (the five remaining names present, the sixth absent); the **public**
 * R2 case (all six present, preserved for a future custom domain); a
 * malformed endpoint still rejected in the private case; each of the five
 * required names individually rejected by name; and an explicit
 * no-credential-values-in-errors check using a distinctive, grep-able
 * sentinel for every `OBJECT_STORAGE_*` variable (including the now-optional
 * sixth).
 *
 * Every case here is genuinely able to fail: `REQUIRED_R2_KEYS`'s exact
 * five-name shape is asserted directly, and the "boots without the sixth
 * name" test was manually verified to fail (mutation-tested) by temporarily
 * re-adding `OBJECT_STORAGE_PUBLIC_BASE_URL` to `REQUIRED_R2_KEYS` in
 * `env.validation.ts`, observing the failure, then reverting — see the
 * 11H-T1 handoff notes for that run's output.
 */
describe('validateEnv — 11H-B1/11H-T1: OBJECT_STORAGE_PUBLIC_BASE_URL is optional', () => {
  const REQUIRED_R2_NAMES = [
    'OBJECT_STORAGE_ENDPOINT',
    'OBJECT_STORAGE_REGION',
    'OBJECT_STORAGE_BUCKET',
    'OBJECT_STORAGE_ACCESS_KEY_ID',
    'OBJECT_STORAGE_SECRET_ACCESS_KEY',
  ] as const;

  /** Five names only — no `OBJECT_STORAGE_PUBLIC_BASE_URL` — the private-bucket case this slice exists for. */
  const PRIVATE_R2_CONFIG: Record<string, unknown> = {
    ...VALID_CONFIG,
    STORAGE_DRIVER: 'r2',
    OBJECT_STORAGE_ENDPOINT: 'https://private.example.invalid',
    OBJECT_STORAGE_REGION: 'auto',
    OBJECT_STORAGE_BUCKET: 'private-test-bucket',
    OBJECT_STORAGE_ACCESS_KEY_ID: 'private-test-access-key-id',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'private-test-secret-access-key',
  };

  it('REQUIRED_R2_KEYS is exactly the five names above (no OBJECT_STORAGE_PUBLIC_BASE_URL)', () => {
    expect(REQUIRED_R2_KEYS).toEqual(REQUIRED_R2_NAMES);
    expect(REQUIRED_R2_KEYS).not.toContain('OBJECT_STORAGE_PUBLIC_BASE_URL');
  });

  it('boots in local mode with zero OBJECT_STORAGE_* variables set at all', () => {
    expect('STORAGE_DRIVER' in VALID_CONFIG).toBe(false);
    for (const name of [
      ...REQUIRED_R2_NAMES,
      'OBJECT_STORAGE_PUBLIC_BASE_URL',
    ]) {
      expect(name in VALID_CONFIG).toBe(false);
    }

    expect(() => validateEnv({ ...VALID_CONFIG })).not.toThrow();
  });

  it('boots in r2 mode with only the five required names present — private R2, no public base URL', () => {
    expect('OBJECT_STORAGE_PUBLIC_BASE_URL' in PRIVATE_R2_CONFIG).toBe(false);

    expect(() => validateEnv({ ...PRIVATE_R2_CONFIG })).not.toThrow();
  });

  it('boots in r2 mode with all six names present — public R2, preserved for a future custom domain', () => {
    expect(() =>
      validateEnv({
        ...PRIVATE_R2_CONFIG,
        OBJECT_STORAGE_PUBLIC_BASE_URL: 'https://media.example.invalid',
      }),
    ).not.toThrow();
  });

  it('rejects a malformed OBJECT_STORAGE_ENDPOINT in the private (no public base URL) case', () => {
    expect(() =>
      validateEnv({
        ...PRIVATE_R2_CONFIG,
        OBJECT_STORAGE_ENDPOINT: 'not-a-valid-url',
      }),
    ).toThrow(/OBJECT_STORAGE_ENDPOINT must be a valid absolute http\(s\) URL/);
  });

  it.each(REQUIRED_R2_NAMES)(
    'rejects r2 mode when %s is individually missing, naming it in the error',
    (key) => {
      const config = omitKey(PRIVATE_R2_CONFIG, key);

      expect(() => validateEnv(config)).toThrow(
        new RegExp(`Missing required environment variable: ${key}`),
      );
    },
  );

  describe('no credential values ever appear in an error message', () => {
    const SENTINEL = 'SENTINEL-11H-DO-NOT-LEAK-7f3c9a2b';

    /** Every OBJECT_STORAGE_* variable — including the optional sixth — set to a distinctive, grep-able fake value. */
    const SENTINEL_R2_CONFIG: Record<string, unknown> = {
      ...VALID_CONFIG,
      STORAGE_DRIVER: 'r2',
      OBJECT_STORAGE_ENDPOINT: `https://${SENTINEL}.example.invalid`,
      OBJECT_STORAGE_REGION: SENTINEL,
      OBJECT_STORAGE_BUCKET: SENTINEL,
      OBJECT_STORAGE_ACCESS_KEY_ID: SENTINEL,
      OBJECT_STORAGE_SECRET_ACCESS_KEY: SENTINEL,
      OBJECT_STORAGE_PUBLIC_BASE_URL: `https://${SENTINEL}.example.invalid`,
    };

    function thrownMessage(config: Record<string, unknown>): string {
      try {
        validateEnv(config);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error(
        'expected validateEnv(config) to throw in this test case, but it did not',
      );
    }

    it.each(REQUIRED_R2_NAMES)(
      'never leaks the sentinel value when %s is the missing name',
      (missingKey) => {
        const message = thrownMessage(omitKey(SENTINEL_R2_CONFIG, missingKey));

        expect(message).not.toContain(SENTINEL);
        expect(message).toContain(missingKey);
      },
    );

    it('never leaks the sentinel value on a malformed endpoint', () => {
      const message = thrownMessage({
        ...SENTINEL_R2_CONFIG,
        OBJECT_STORAGE_ENDPOINT: 'not-a-valid-url',
      });

      expect(message).not.toContain(SENTINEL);
    });
  });
});

/**
 * Slice 11N — HLS Processing Data Model + Queue Foundation. `REDIS_URL` is
 * required only when `TRANSCODE_ENABLED=true`, mirroring the
 * `STORAGE_DRIVER`/`OBJECT_STORAGE_*` conditional-validation shape above
 * exactly (2026-08-10 DECISIONS.md approval, item: "mirror the 11G-3
 * conditional env-var pattern").
 */
describe('validateEnv — TRANSCODE_ENABLED / REDIS_URL (Slice 11N)', () => {
  it('boots with TRANSCODE_ENABLED unset and no REDIS_URL at all', () => {
    expect(() => validateEnv({ ...VALID_CONFIG })).not.toThrow();
  });

  it.each(['', 'TRUE', 'True', '1', 'yes', 'false', 'garbage'])(
    'boots with no REDIS_URL when TRANSCODE_ENABLED=%s (only the exact string "true" requires it)',
    (value) => {
      expect(() =>
        validateEnv({ ...VALID_CONFIG, TRANSCODE_ENABLED: value }),
      ).not.toThrow();
    },
  );

  it('boots when TRANSCODE_ENABLED=true and REDIS_URL is a valid redis:// URL', () => {
    expect(() =>
      validateEnv({
        ...VALID_CONFIG,
        TRANSCODE_ENABLED: 'true',
        REDIS_URL: 'redis://localhost:6379',
        // Slice 11Q: HLS_TOKEN_SECRET/HLS_GATEWAY_BASE_URL are ALSO
        // required once TRANSCODE_ENABLED=true (see the dedicated Slice
        // 11Q describe block below) — included here so this Slice 11N
        // test keeps proving what IT is about (REDIS_URL) without
        // incidentally tripping the newer, independent HLS gateway check.
        HLS_TOKEN_SECRET: 'test-hls-token-secret',
        HLS_GATEWAY_BASE_URL: 'https://hls-gateway.example.test',
      }),
    ).not.toThrow();
  });

  it('boots when TRANSCODE_ENABLED=true and REDIS_URL uses the TLS rediss:// scheme', () => {
    expect(() =>
      validateEnv({
        ...VALID_CONFIG,
        TRANSCODE_ENABLED: 'true',
        REDIS_URL: 'rediss://localhost:6380',
        HLS_TOKEN_SECRET: 'test-hls-token-secret',
        HLS_GATEWAY_BASE_URL: 'https://hls-gateway.example.test',
      }),
    ).not.toThrow();
  });

  it('throws naming REDIS_URL when TRANSCODE_ENABLED=true and REDIS_URL is absent', () => {
    expect(() =>
      validateEnv({ ...VALID_CONFIG, TRANSCODE_ENABLED: 'true' }),
    ).toThrow(/Missing required environment variable: REDIS_URL/);
  });

  it('rejects a malformed REDIS_URL when TRANSCODE_ENABLED=true (shape check only, no network)', () => {
    expect(() =>
      validateEnv({
        ...VALID_CONFIG,
        TRANSCODE_ENABLED: 'true',
        REDIS_URL: 'not-a-valid-url',
      }),
    ).toThrow(/REDIS_URL must be a valid redis:\/\/ or rediss:\/\/ URL/);
  });

  it('rejects a non-redis scheme when TRANSCODE_ENABLED=true (e.g. http://)', () => {
    expect(() =>
      validateEnv({
        ...VALID_CONFIG,
        TRANSCODE_ENABLED: 'true',
        REDIS_URL: 'http://localhost:6379',
      }),
    ).toThrow(/REDIS_URL must be a valid redis:\/\/ or rediss:\/\/ URL/);
  });

  it('never echoes a REDIS_URL value in the thrown message', () => {
    const sentinel = 'redis://SENTINEL-11N-DO-NOT-LEAK-a1b2c3@localhost:6379';
    let caught: Error | undefined;

    try {
      validateEnv({
        ...VALID_CONFIG,
        TRANSCODE_ENABLED: 'true',
        REDIS_URL: `not-a-valid-url-but-contains-${sentinel}`,
      });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).not.toContain(sentinel);
  });
});

/**
 * Slice 11P — the three optional numeric tunables
 * (TRANSCODE_MAX_ATTEMPTS/TRANSCODE_STALLED_AFTER_MINUTES/
 * TRANSCODE_CLEANUP_GRACE_MINUTES), validated only when TRANSCODE_ENABLED is
 * exactly "true", mirroring the REDIS_URL conditional shape above — but
 * unlike REDIS_URL, none of these three is REQUIRED to be present; only a
 * PRESENT-but-invalid value fails boot.
 */
describe('validateEnv — TRANSCODE_MAX_ATTEMPTS / TRANSCODE_STALLED_AFTER_MINUTES / TRANSCODE_CLEANUP_GRACE_MINUTES (Slice 11P)', () => {
  const ENABLED_BASE: Record<string, unknown> = {
    ...VALID_CONFIG,
    TRANSCODE_ENABLED: 'true',
    REDIS_URL: 'redis://localhost:6379',
    // Slice 11Q: required once TRANSCODE_ENABLED=true — see the dedicated
    // Slice 11Q describe block below for that check's own coverage.
    HLS_TOKEN_SECRET: 'test-hls-token-secret',
    HLS_GATEWAY_BASE_URL: 'https://hls-gateway.example.test',
  };

  it('boots with TRANSCODE_ENABLED=true and none of the three set (all fall back to their defaults)', () => {
    expect(() => validateEnv({ ...ENABLED_BASE })).not.toThrow();
  });

  it('ignores all three entirely when TRANSCODE_ENABLED is not "true", even if malformed', () => {
    expect(() =>
      validateEnv({
        ...VALID_CONFIG,
        TRANSCODE_MAX_ATTEMPTS: 'not-a-number',
        TRANSCODE_STALLED_AFTER_MINUTES: '-5',
        TRANSCODE_CLEANUP_GRACE_MINUTES: '0',
      }),
    ).not.toThrow();
  });

  it.each([
    'TRANSCODE_MAX_ATTEMPTS',
    'TRANSCODE_STALLED_AFTER_MINUTES',
    'TRANSCODE_CLEANUP_GRACE_MINUTES',
  ])('boots when %s is a valid positive integer', (key) => {
    expect(() => validateEnv({ ...ENABLED_BASE, [key]: '5' })).not.toThrow();
  });

  it.each([
    'TRANSCODE_MAX_ATTEMPTS',
    'TRANSCODE_STALLED_AFTER_MINUTES',
    'TRANSCODE_CLEANUP_GRACE_MINUTES',
  ])('rejects %s=0 (must be strictly positive)', (key) => {
    expect(() => validateEnv({ ...ENABLED_BASE, [key]: '0' })).toThrow(
      new RegExp(`Invalid ${key}: must be a positive integer`),
    );
  });

  it.each([
    'TRANSCODE_MAX_ATTEMPTS',
    'TRANSCODE_STALLED_AFTER_MINUTES',
    'TRANSCODE_CLEANUP_GRACE_MINUTES',
  ])('rejects a negative %s', (key) => {
    expect(() => validateEnv({ ...ENABLED_BASE, [key]: '-3' })).toThrow(
      new RegExp(`Invalid ${key}: must be a positive integer`),
    );
  });

  it.each([
    'TRANSCODE_MAX_ATTEMPTS',
    'TRANSCODE_STALLED_AFTER_MINUTES',
    'TRANSCODE_CLEANUP_GRACE_MINUTES',
  ])('rejects a non-numeric %s', (key) => {
    expect(() => validateEnv({ ...ENABLED_BASE, [key]: 'garbage' })).toThrow(
      new RegExp(`Invalid ${key}: must be a positive integer`),
    );
  });

  it.each([
    'TRANSCODE_MAX_ATTEMPTS',
    'TRANSCODE_STALLED_AFTER_MINUTES',
    'TRANSCODE_CLEANUP_GRACE_MINUTES',
  ])('rejects a non-integer (float) %s', (key) => {
    expect(() => validateEnv({ ...ENABLED_BASE, [key]: '2.5' })).toThrow(
      new RegExp(`Invalid ${key}: must be a positive integer`),
    );
  });
});

/**
 * Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION": `PAYMENTS_ENABLED`
 * requires `MIDTRANS_SERVER_KEY` (name-presence only), mirroring the
 * TRANSCODE_ENABLED/REDIS_URL conditional pattern; and
 * `MIDTRANS_IS_PRODUCTION=true` is a fail-closed allowlist on
 * `NODE_ENV === 'production'` — the real-money endpoint can never be
 * selected from a dev/test environment, and sandbox is always the default.
 */
describe('validateEnv — PAYMENTS_ENABLED / MIDTRANS_* (MIDTRANS PAYMENT BACKEND FOUNDATION)', () => {
  const SECRET_VALUE = 'SB-Mid-server-spec-fixture-value';

  it('boots with every payments variable unset (the shipped default posture)', () => {
    expect(() => validateEnv({ ...VALID_CONFIG })).not.toThrow();
  });

  it('boots with PAYMENTS_ENABLED=false and no MIDTRANS_* variable', () => {
    expect(() =>
      validateEnv({ ...VALID_CONFIG, PAYMENTS_ENABLED: 'false' }),
    ).not.toThrow();
  });

  it('PAYMENTS_ENABLED=true without MIDTRANS_SERVER_KEY fails naming the variable', () => {
    expect(() =>
      validateEnv({ ...VALID_CONFIG, PAYMENTS_ENABLED: 'true' }),
    ).toThrow(/Missing required environment variable: MIDTRANS_SERVER_KEY/);
  });

  it('PAYMENTS_ENABLED=true with MIDTRANS_SERVER_KEY boots (sandbox default)', () => {
    expect(() =>
      validateEnv({
        ...VALID_CONFIG,
        PAYMENTS_ENABLED: 'true',
        MIDTRANS_SERVER_KEY: SECRET_VALUE,
      }),
    ).not.toThrow();
  });

  it('only the exact string "true" enables the requirement (fail-closed flag parsing)', () => {
    for (const nonTrue of ['TRUE', '1', 'yes', '']) {
      expect(() =>
        validateEnv({ ...VALID_CONFIG, PAYMENTS_ENABLED: nonTrue }),
      ).not.toThrow();
    }
  });

  describe('MIDTRANS_IS_PRODUCTION allowlist', () => {
    it.each(['test', 'development', 'Production', 'staging', ''])(
      'CRITICAL: MIDTRANS_IS_PRODUCTION=true refuses to boot with NODE_ENV=%s',
      (nodeEnv) => {
        expect(() =>
          validateEnv({
            ...VALID_CONFIG,
            NODE_ENV: nodeEnv,
            MIDTRANS_IS_PRODUCTION: 'true',
          }),
        ).toThrow(/Refusing to boot with MIDTRANS_IS_PRODUCTION=true/);
      },
    );

    it('CRITICAL: MIDTRANS_IS_PRODUCTION=true refuses to boot with NODE_ENV unset', () => {
      expect(() =>
        validateEnv({ ...VALID_CONFIG, MIDTRANS_IS_PRODUCTION: 'true' }),
      ).toThrow(/Refusing to boot with MIDTRANS_IS_PRODUCTION=true/);
    });

    it('the production check applies even while payments are disabled', () => {
      expect(() =>
        validateEnv({
          ...VALID_CONFIG,
          NODE_ENV: 'test',
          PAYMENTS_ENABLED: 'false',
          MIDTRANS_IS_PRODUCTION: 'true',
        }),
      ).toThrow(/Refusing to boot with MIDTRANS_IS_PRODUCTION=true/);
    });

    it('MIDTRANS_IS_PRODUCTION=true + NODE_ENV=production boots', () => {
      expect(() =>
        validateEnv({
          ...VALID_CONFIG,
          NODE_ENV: 'production',
          PAYMENTS_ENABLED: 'true',
          MIDTRANS_SERVER_KEY: SECRET_VALUE,
          MIDTRANS_IS_PRODUCTION: 'true',
          // As in buildConfig above: production requires an https
          // PUBLIC_BASE_URL and rejects a dev CORS origin. This test's
          // subject is MIDTRANS_IS_PRODUCTION.
          PUBLIC_BASE_URL: 'https://api.example.com',
          CORS_ORIGINS: '',
        }),
      ).not.toThrow();
    });

    it('MIDTRANS_IS_PRODUCTION unset/false boots under any NODE_ENV (sandbox is the default)', () => {
      expect(() =>
        validateEnv({ ...VALID_CONFIG, NODE_ENV: 'test' }),
      ).not.toThrow();
      expect(() =>
        validateEnv({
          ...VALID_CONFIG,
          NODE_ENV: 'test',
          MIDTRANS_IS_PRODUCTION: 'false',
        }),
      ).not.toThrow();
    });
  });

  it('no MIDTRANS_SERVER_KEY value ever appears in an error message', () => {
    try {
      validateEnv({
        ...VALID_CONFIG,
        NODE_ENV: 'test',
        PAYMENTS_ENABLED: 'true',
        MIDTRANS_SERVER_KEY: SECRET_VALUE,
        MIDTRANS_IS_PRODUCTION: 'true',
      });
      throw new Error('expected validateEnv to throw');
    } catch (error) {
      expect(String(error)).not.toContain(SECRET_VALUE);
    }
  });
});

/**
 * PRODUCTION HTTPS READINESS: `TRUST_PROXY_HOPS`. Optional (default 0), but
 * must be a well-formed non-negative integer when set — validated
 * UNCONDITIONALLY, since unlike the transcode/payment knobs this value is
 * read on every request path in every deployment. Entirely in-memory: no
 * network call, no real credential, no filesystem access beyond the
 * `STORAGE_ROOT: process.cwd()` the shared `VALID_CONFIG` already uses.
 */
describe('validateEnv — TRUST_PROXY_HOPS (production HTTPS readiness)', () => {
  it('passes when TRUST_PROXY_HOPS is absent (the documented default applies)', () => {
    expect(() => validateEnv({ ...VALID_CONFIG })).not.toThrow();
  });

  it('passes when TRUST_PROXY_HOPS is blank (treated as not set)', () => {
    expect(() =>
      validateEnv({ ...VALID_CONFIG, TRUST_PROXY_HOPS: '   ' }),
    ).not.toThrow();
  });

  it('accepts "0" — the explicit "no reverse proxy" answer, not a mistake', () => {
    expect(() =>
      validateEnv({ ...VALID_CONFIG, TRUST_PROXY_HOPS: '0' }),
    ).not.toThrow();
  });

  it('accepts a positive hop count', () => {
    expect(() =>
      validateEnv({ ...VALID_CONFIG, TRUST_PROXY_HOPS: '1' }),
    ).not.toThrow();
  });

  it.each(['one', '1.5', '-1', '1x'])(
    'throws for the malformed value %p rather than silently falling back to 0',
    (value) => {
      expect(() =>
        validateEnv({ ...VALID_CONFIG, TRUST_PROXY_HOPS: value }),
      ).toThrow(/Invalid TRUST_PROXY_HOPS/);
    },
  );

  it('names the offending value, which is a hop count and never a secret', () => {
    expect(() =>
      validateEnv({ ...VALID_CONFIG, TRUST_PROXY_HOPS: 'one' }),
    ).toThrow(/TRUST_PROXY_HOPS="one"/);
  });

  it('throws for a non-string value', () => {
    expect(() => validateEnv({ ...VALID_CONFIG, TRUST_PROXY_HOPS: 1 })).toThrow(
      /Invalid TRUST_PROXY_HOPS/,
    );
  });
});

/**
 * The three unconditionally-required auth secrets must differ from one
 * another. `.env.production.example` has always DOCUMENTED this ("Must be
 * different from JWT_ACCESS_SECRET") and `HLS_TOKEN_SECRET` has always
 * ENFORCED it against all three — but nothing enforced it among the three
 * themselves, so one value pasted into all three lines booted cleanly.
 *
 * Every value below is an obvious placeholder; no real secret appears here,
 * and the assertions only ever match on variable NAMES.
 */
describe('validateEnv — the auth secrets must be distinct from each other', () => {
  const SHARED = 'the-same-secret-in-two-places';

  it('boots when all three secrets differ (the VALID_CONFIG baseline)', () => {
    expect(() => validateEnv({ ...VALID_CONFIG })).not.toThrow();
  });

  it.each([
    ['JWT_REFRESH_SECRET', 'JWT_ACCESS_SECRET'],
    ['AUTH_AUDIT_IP_HASH_SECRET', 'JWT_ACCESS_SECRET'],
    ['AUTH_AUDIT_IP_HASH_SECRET', 'JWT_REFRESH_SECRET'],
  ])('REFUSES %s reused as %s', (offender, collidesWith) => {
    expect(() =>
      validateEnv({
        ...VALID_CONFIG,
        [collidesWith]: SHARED,
        [offender]: SHARED,
      }),
    ).toThrow(
      new RegExp(`Invalid ${offender}: must be DISTINCT from ${collidesWith}`),
    );
  });

  it('REFUSES one value pasted into all three', () => {
    expect(() =>
      validateEnv({
        ...VALID_CONFIG,
        JWT_ACCESS_SECRET: SHARED,
        JWT_REFRESH_SECRET: SHARED,
        AUTH_AUDIT_IP_HASH_SECRET: SHARED,
      }),
    ).toThrow(/must be DISTINCT from/);
  });

  it('never echoes a secret value, only the two variable names', () => {
    let message = '';
    try {
      validateEnv({
        ...VALID_CONFIG,
        JWT_ACCESS_SECRET: SHARED,
        JWT_REFRESH_SECRET: SHARED,
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('JWT_REFRESH_SECRET');
    expect(message).toContain('JWT_ACCESS_SECRET');
    expect(message).not.toContain(SHARED);
  });

  it('applies in every environment, not only production — a dev machine with one shared secret is still wrong', () => {
    for (const nodeEnv of ['development', 'test', undefined]) {
      expect(() =>
        validateEnv({
          ...VALID_CONFIG,
          NODE_ENV: nodeEnv,
          JWT_ACCESS_SECRET: SHARED,
          JWT_REFRESH_SECRET: SHARED,
        }),
      ).toThrow(/must be DISTINCT from/);
    }
  });
});

/**
 * PRODUCTION HTTPS READINESS — the production network contract.
 *
 * Every variable exercised below becomes a URL the ANDROID CLIENT fetches.
 * They all fail the same silent way when they are wrong: the API answers
 * 200, `/health` is green, the mobile release preflight (which validates
 * `EXPO_PUBLIC_API_BASE_URL`, not the URLs the API returns) passes, and
 * playback simply never starts on a real device.
 *
 * The negative-space tests matter as much as the positive ones: none of
 * these rules may fire for the LAN/localhost URLs that local development
 * and CI both legitimately use.
 *
 * NO REAL VALUE APPEARS HERE. Every host is `example.com`/`.invalid` and
 * every secret is an obvious placeholder.
 */

/** A minimal production-valid baseline: https public origin, deny-all CORS. */
const PRODUCTION_CONFIG: Record<string, unknown> = {
  ...VALID_CONFIG,
  NODE_ENV: 'production',
  PUBLIC_BASE_URL: 'https://api.example.com',
  CORS_ORIGINS: '',
};

/**
 * The shapes a developer machine produces, which must never survive a
 * production boot for any client-facing URL. Reused across every variable
 * below so a rule can never be enforced for one and forgotten for another.
 */
const UNSAFE_PRODUCTION_URLS: Array<{
  label: string;
  url: string;
  expected: RegExp;
}> = [
  {
    label: 'cleartext http',
    url: 'http://api.example.com',
    expected: /it must use https/,
  },
  {
    label: 'https loopback name',
    url: 'https://localhost:3000',
    expected: /is a loopback address/,
  },
  {
    label: 'https loopback address',
    url: 'https://127.0.0.1:3000',
    expected: /is a loopback address/,
  },
  {
    label: 'http loopback',
    url: 'http://localhost:3000',
    expected: /it must use https/,
  },
  {
    label: 'https LAN address',
    url: 'https://192.168.110.144:3000',
    expected: /private\/LAN address/,
  },
  {
    label: 'https 10/8 address',
    url: 'https://10.1.2.3:3000',
    expected: /private\/LAN address/,
  },
  {
    label: 'https mDNS .local',
    url: 'https://glady-mac.local:3000',
    expected: /private\/LAN address/,
  },
];

/**
 * Malformed values are rejected too, but the message depends on the
 * variable: `OBJECT_STORAGE_ENDPOINT` and `HLS_GATEWAY_BASE_URL` each
 * already had their own absolute-URL shape check from an earlier slice, and
 * those run BEFORE the production block. Kept as a separate table so the
 * tests assert what actually happens rather than assuming one message.
 */
const MALFORMED_URLS = ['api.example.com', ':::'];

describe('validateEnv — PUBLIC_BASE_URL must be a public https origin in production', () => {
  it('accepts an https origin under NODE_ENV=production', () => {
    expect(() => validateEnv({ ...PRODUCTION_CONFIG })).not.toThrow();
  });

  it.each(UNSAFE_PRODUCTION_URLS)(
    'REFUSES $label ($url)',
    ({ url, expected }) => {
      expect(() =>
        validateEnv({ ...PRODUCTION_CONFIG, PUBLIC_BASE_URL: url }),
      ).toThrow(expected);
    },
  );

  it.each(MALFORMED_URLS)('REFUSES the malformed value %p', (url) => {
    expect(() =>
      validateEnv({ ...PRODUCTION_CONFIG, PUBLIC_BASE_URL: url }),
    ).toThrow(/must be an absolute URL/);
  });

  it('leaves local development alone — the default VALID_CONFIG is http://localhost:3000', () => {
    expect(() => validateEnv({ ...VALID_CONFIG })).not.toThrow();
  });

  it.each(['development', 'test', undefined, '', 'Production'])(
    'does not fire for NODE_ENV=%p, so a LAN URL still boots outside production',
    (nodeEnv) => {
      expect(() =>
        validateEnv({
          ...VALID_CONFIG,
          NODE_ENV: nodeEnv,
          PUBLIC_BASE_URL: 'http://192.168.110.144:3000',
        }),
      ).not.toThrow();
    },
  );

  it('names the offending origin, which is public information, not a secret', () => {
    expect(() =>
      validateEnv({
        ...PRODUCTION_CONFIG,
        PUBLIC_BASE_URL: 'http://api.example.com',
      }),
    ).toThrow(/"http:\/\/api\.example\.com"/);
  });
});

/**
 * `OBJECT_STORAGE_ENDPOINT` is the one that reads like internal
 * infrastructure and is not: every presigned GET URL is SIGNED AGAINST IT,
 * so its scheme and host become the `playbackUrl` of every R2-backed row
 * and the `coverUrl` of every series. A MinIO-on-the-LAN endpoint in
 * production produces `http://192.168.x.x:9000/...` playback URLs.
 */
describe('validateEnv — OBJECT_STORAGE_ENDPOINT must be a public https origin in production', () => {
  const R2_PRODUCTION_CONFIG: Record<string, unknown> = {
    ...PRODUCTION_CONFIG,
    STORAGE_DRIVER: 'r2',
    OBJECT_STORAGE_ENDPOINT: 'https://account.r2.cloudflarestorage.invalid',
    OBJECT_STORAGE_REGION: 'auto',
    OBJECT_STORAGE_BUCKET: 'test-bucket',
    OBJECT_STORAGE_ACCESS_KEY_ID: 'test-access-key-id',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'test-secret-access-key',
  };

  it('accepts a public https endpoint under NODE_ENV=production', () => {
    expect(() => validateEnv({ ...R2_PRODUCTION_CONFIG })).not.toThrow();
  });

  it.each(UNSAFE_PRODUCTION_URLS)(
    'REFUSES $label ($url)',
    ({ url, expected }) => {
      expect(() =>
        validateEnv({ ...R2_PRODUCTION_CONFIG, OBJECT_STORAGE_ENDPOINT: url }),
      ).toThrow(expected);
    },
  );

  it.each(MALFORMED_URLS)(
    'REFUSES the malformed value %p via the pre-existing r2 shape check',
    (url) => {
      expect(() =>
        validateEnv({ ...R2_PRODUCTION_CONFIG, OBJECT_STORAGE_ENDPOINT: url }),
      ).toThrow(
        /OBJECT_STORAGE_ENDPOINT must be a valid absolute http\(s\) URL/,
      );
    },
  );

  it('does not fire in local storage mode, where nothing is ever signed against it', () => {
    expect(() =>
      validateEnv({
        ...PRODUCTION_CONFIG,
        OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
      }),
    ).not.toThrow();
  });

  it('does not fire outside production — a local MinIO endpoint stays usable in development', () => {
    expect(() =>
      validateEnv({
        ...R2_PRODUCTION_CONFIG,
        NODE_ENV: 'development',
        PUBLIC_BASE_URL: 'http://localhost:3000',
        CORS_ORIGINS: 'http://localhost:8081',
        OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
      }),
    ).not.toThrow();
  });
});

/**
 * `HLS_GATEWAY_BASE_URL` is stamped into `masterUrl` and every rendition
 * URL of an HLS-ready row. Gated on `TRANSCODE_ENABLED=true`, mirroring
 * `validateHlsGatewayConfig`'s own gate — while the flag is off (this
 * repo's shipped default) the gateway is never consulted.
 */
describe('validateEnv — HLS_GATEWAY_BASE_URL must be a public https origin in production', () => {
  const HLS_PRODUCTION_CONFIG: Record<string, unknown> = {
    ...PRODUCTION_CONFIG,
    TRANSCODE_ENABLED: 'true',
    REDIS_URL: 'redis://redis.internal:6379',
    HLS_TOKEN_SECRET: 'test-hls-token-secret-distinct-from-jwt',
    HLS_GATEWAY_BASE_URL: 'https://hls.example.com',
  };

  it('accepts a public https gateway under NODE_ENV=production', () => {
    expect(() => validateEnv({ ...HLS_PRODUCTION_CONFIG })).not.toThrow();
  });

  it.each(UNSAFE_PRODUCTION_URLS)(
    'REFUSES $label ($url)',
    ({ url, expected }) => {
      expect(() =>
        validateEnv({ ...HLS_PRODUCTION_CONFIG, HLS_GATEWAY_BASE_URL: url }),
      ).toThrow(expected);
    },
  );

  it.each(MALFORMED_URLS)(
    'REFUSES the malformed value %p via the pre-existing TRANSCODE_ENABLED shape check',
    (url) => {
      expect(() =>
        validateEnv({ ...HLS_PRODUCTION_CONFIG, HLS_GATEWAY_BASE_URL: url }),
      ).toThrow(/HLS_GATEWAY_BASE_URL must be a valid absolute http\(s\) URL/);
    },
  );

  it("does not fire while TRANSCODE_ENABLED is off, matching validateHlsGatewayConfig's own gate", () => {
    expect(() =>
      validateEnv({
        ...PRODUCTION_CONFIG,
        HLS_GATEWAY_BASE_URL: 'http://localhost:8787',
      }),
    ).not.toThrow();
  });

  it('does not fire outside production — a local wrangler dev gateway stays usable', () => {
    expect(() =>
      validateEnv({
        ...HLS_PRODUCTION_CONFIG,
        NODE_ENV: 'development',
        PUBLIC_BASE_URL: 'http://localhost:3000',
        CORS_ORIGINS: 'http://localhost:8081',
        HLS_GATEWAY_BASE_URL: 'http://localhost:8787',
      }),
    ).not.toThrow();
  });

  /**
   * INFRASTRUCTURE URLs MUST NOT BE CAUGHT BY THIS RULE. `REDIS_URL` and
   * `DATABASE_URL` are consumed by this process and never handed to a
   * client, and a platform's private hostname is exactly the shape the
   * public-URL rules reject. A regression here would break every correct
   * production deployment.
   */
  it('never applies the public-https rules to REDIS_URL or DATABASE_URL', () => {
    expect(() =>
      validateEnv({
        ...HLS_PRODUCTION_CONFIG,
        REDIS_URL: 'redis://10.0.0.5:6379',
        DATABASE_URL: 'postgresql://user:pass@10.0.0.4:5432/db',
      }),
    ).not.toThrow();
  });
});

/**
 * `OBJECT_STORAGE_PUBLIC_BASE_URL` is optional in every mode (it has no
 * production caller today — `StorageService.buildPublicUrl` is unused
 * outside its own spec), so it is validated only WHEN SET.
 */
describe('validateEnv — OBJECT_STORAGE_PUBLIC_BASE_URL when set in production', () => {
  it('accepts a public https media base', () => {
    expect(() =>
      validateEnv({
        ...PRODUCTION_CONFIG,
        OBJECT_STORAGE_PUBLIC_BASE_URL: 'https://media.example.com',
      }),
    ).not.toThrow();
  });

  it('REFUSES a cleartext media base', () => {
    expect(() =>
      validateEnv({
        ...PRODUCTION_CONFIG,
        OBJECT_STORAGE_PUBLIC_BASE_URL: 'http://media.example.com',
      }),
    ).toThrow(/it must use https/);
  });

  it('stays optional — an absent or blank value boots', () => {
    expect(() => validateEnv({ ...PRODUCTION_CONFIG })).not.toThrow();
    expect(() =>
      validateEnv({ ...PRODUCTION_CONFIG, OBJECT_STORAGE_PUBLIC_BASE_URL: '' }),
    ).not.toThrow();
  });
});

/**
 * CORS. Three separate defects are covered here — see `validateCorsOrigins`
 * for the full rationale.
 */
describe('validateEnv — CORS_ORIGINS', () => {
  describe('presence without requiring a value', () => {
    /**
     * REGRESSION GUARD for a real production blocker: `CORS_ORIGINS` used to
     * live in `REQUIRED_KEYS`, whose loop rejects any FALSY value — so the
     * EMPTY value that `.env.production.example` ships, and that
     * `docs/PRODUCTION_DEPLOYMENT_REQUIREMENTS.md` documents as correct for
     * a mobile-only V1, refused the boot with "Missing required environment
     * variable". Following the shipped contract exactly produced a process
     * that would not start.
     */
    it('accepts an EMPTY value — the documented deny-all answer for a mobile-only V1', () => {
      expect(() =>
        validateEnv({ ...VALID_CONFIG, CORS_ORIGINS: '' }),
      ).not.toThrow();
    });

    it('accepts an empty value in production too', () => {
      expect(() => validateEnv({ ...PRODUCTION_CONFIG })).not.toThrow();
    });

    it('still requires the variable to be DECLARED, so deny-all is a choice and not an omission', () => {
      expect(() => validateEnv(omitKey(VALID_CONFIG, 'CORS_ORIGINS'))).toThrow(
        /Missing required environment variable: CORS_ORIGINS/,
      );
    });

    it('explains that empty is valid, so the fix is obvious from the message alone', () => {
      expect(() => validateEnv(omitKey(VALID_CONFIG, 'CORS_ORIGINS'))).toThrow(
        /EMPTY value is valid/,
      );
    });
  });

  describe('the "*" trap — rejected in EVERY environment', () => {
    /**
     * `configuration.ts` always parses this variable into an ARRAY, and the
     * `cors` package compares array entries to the request Origin with
     * `===`. Its wildcard branch only fires for the literal STRING `'*'`,
     * which an array can never be — so `CORS_ORIGINS=*` allows an origin
     * literally named `*`, i.e. nothing at all. It fails safe, but silently
     * and in the opposite direction from what was intended.
     */
    it.each(['production', 'development', 'test', undefined])(
      'refuses a bare "*" under NODE_ENV=%p',
      (nodeEnv) => {
        expect(() =>
          validateEnv({
            ...VALID_CONFIG,
            NODE_ENV: nodeEnv,
            CORS_ORIGINS: '*',
          }),
        ).toThrow(/does not allow every origin/);
      },
    );

    it('refuses a "*" hidden among real origins', () => {
      expect(() =>
        validateEnv({
          ...PRODUCTION_CONFIG,
          CORS_ORIGINS: 'https://admin.example.com,*',
        }),
      ).toThrow(/does not allow every origin/);
    });
  });

  describe('production origin shape', () => {
    it('accepts exact https origins, with and without a port', () => {
      expect(() =>
        validateEnv({
          ...PRODUCTION_CONFIG,
          CORS_ORIGINS:
            'https://admin.example.com,https://ops.example.com:8443',
        }),
      ).not.toThrow();
    });

    it('REFUSES a cleartext origin', () => {
      expect(() =>
        validateEnv({
          ...PRODUCTION_CONFIG,
          CORS_ORIGINS: 'http://admin.example.com',
        }),
      ).toThrow(/must use https/);
    });

    it.each([
      'https://localhost:5173',
      'https://127.0.0.1:5173',
      'https://192.168.1.39:8082',
      'https://glady-mac.local:5173',
    ])('REFUSES the leftover development origin %s', (origin) => {
      expect(() =>
        validateEnv({ ...PRODUCTION_CONFIG, CORS_ORIGINS: origin }),
      ).toThrow(/loopback\/LAN host/);
    });

    /**
     * A browser's `Origin` header is always exactly `scheme://host[:port]`.
     * A trailing slash — the shape a person copies out of an address bar —
     * silently matches nothing, so the API looks broken rather than
     * misconfigured.
     */
    it.each([
      'https://admin.example.com/',
      'https://admin.example.com/admin',
      'https://admin.example.com?x=1',
      'https://admin.example.com#frag',
    ])('REFUSES %s, which would silently match no browser Origin', (origin) => {
      expect(() =>
        validateEnv({ ...PRODUCTION_CONFIG, CORS_ORIGINS: origin }),
      ).toThrow(/bare origin with no path, query, fragment or trailing slash/);
    });

    it('suggests the corrected origin in the error', () => {
      expect(() =>
        validateEnv({
          ...PRODUCTION_CONFIG,
          CORS_ORIGINS: 'https://admin.example.com/',
        }),
      ).toThrow(/"https:\/\/admin\.example\.com"/);
    });

    it('does not fire outside production — dev keeps its localhost origins', () => {
      expect(() =>
        validateEnv({
          ...VALID_CONFIG,
          CORS_ORIGINS: 'http://localhost:8082,http://192.168.1.39:8082',
        }),
      ).not.toThrow();
    });
  });
});

/**
 * ORDERING. `validateEnv` runs the production URL/CORS block LAST, so a
 * config that is wrong in several ways reports the SECURITY problem first.
 * The existing comment at the call site records why: an earlier version
 * reported a bad base URL and hid a privilege-escalation misconfiguration
 * sitting in the same file.
 */
describe('validateEnv — production check ordering', () => {
  it('reports DEV_TOOLS_ENABLED before a cleartext PUBLIC_BASE_URL', () => {
    expect(() =>
      validateEnv({
        ...PRODUCTION_CONFIG,
        DEV_TOOLS_ENABLED: 'true',
        PUBLIC_BASE_URL: 'http://api.example.com',
      }),
    ).toThrow(/Refusing to boot with DEV_TOOLS_ENABLED=true/);
  });

  it('reports a cleartext PUBLIC_BASE_URL before a leftover development CORS origin', () => {
    expect(() =>
      validateEnv({
        ...PRODUCTION_CONFIG,
        PUBLIC_BASE_URL: 'http://api.example.com',
        CORS_ORIGINS: 'http://localhost:5173',
      }),
    ).toThrow(/PUBLIC_BASE_URL/);
  });
});

/**
 * Work unit "V1 FREE ACCESS POLICY": `CONTENT_ACCESS_MODE` is a named-mode
 * ALLOWLIST, not an exact-string boolean flag. A typo must fail the boot
 * rather than resolving to whichever mode `!== 'free'` happens to mean —
 * see `validateContentAccessMode`'s doc comment for why this setting has no
 * "safe direction" to fall back in.
 */
describe('validateEnv — CONTENT_ACCESS_MODE (V1 FREE ACCESS POLICY)', () => {
  it('passes when CONTENT_ACCESS_MODE is absent (unset means entitlement)', () => {
    expect(() => validateEnv({ ...VALID_CONFIG })).not.toThrow();
  });

  it('passes when CONTENT_ACCESS_MODE is empty', () => {
    expect(() =>
      validateEnv({ ...VALID_CONFIG, CONTENT_ACCESS_MODE: '' }),
    ).not.toThrow();
  });

  it('passes for the two known modes', () => {
    expect(() =>
      validateEnv({ ...VALID_CONFIG, CONTENT_ACCESS_MODE: 'entitlement' }),
    ).not.toThrow();
    expect(() =>
      validateEnv({ ...VALID_CONFIG, CONTENT_ACCESS_MODE: 'free' }),
    ).not.toThrow();
  });

  it('throws, naming both valid modes, for an unknown value', () => {
    expect(() =>
      validateEnv({ ...VALID_CONFIG, CONTENT_ACCESS_MODE: 'freemium' }),
    ).toThrow(/Invalid CONTENT_ACCESS_MODE: "freemium"/);
    expect(() =>
      validateEnv({ ...VALID_CONFIG, CONTENT_ACCESS_MODE: 'freemium' }),
    ).toThrow(/entitlement, free/);
  });

  it('throws for a differently-cased near-miss rather than silently choosing a mode', () => {
    for (const nearMiss of ['Free', 'FREE', 'Entitlement', 'true']) {
      expect(() =>
        validateEnv({ ...VALID_CONFIG, CONTENT_ACCESS_MODE: nearMiss }),
      ).toThrow(/Invalid CONTENT_ACCESS_MODE/);
    }
  });

  it('never echoes any other environment value in the error message', () => {
    let message = '';
    try {
      validateEnv({
        ...VALID_CONFIG,
        CONTENT_ACCESS_MODE: 'bogus',
        JWT_ACCESS_SECRET: 'super-secret-value-that-must-not-leak',
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/Invalid CONTENT_ACCESS_MODE/);
    expect(message).not.toContain('super-secret-value-that-must-not-leak');
  });
});
