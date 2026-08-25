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
          // PUBLIC_BASE_URL. This test's subject is MIDTRANS_IS_PRODUCTION.
          PUBLIC_BASE_URL: 'https://api.example.com',
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
 * PRODUCTION HTTPS READINESS: `PUBLIC_BASE_URL` must be https in production,
 * because it is stamped into every local-storage row's `playbackUrl` and an
 * http value fails on the device rather than at boot.
 *
 * The negative-space tests matter as much as the positive ones: this check
 * must NOT fire for the LAN/localhost URLs local development and CI both use.
 */
describe('validateEnv — PUBLIC_BASE_URL https in production', () => {
  it('accepts an https origin under NODE_ENV=production', () => {
    expect(() =>
      validateEnv({
        ...VALID_CONFIG,
        NODE_ENV: 'production',
        PUBLIC_BASE_URL: 'https://api.example.com',
      }),
    ).not.toThrow();
  });

  it('REFUSES an http origin under NODE_ENV=production', () => {
    expect(() =>
      validateEnv({
        ...VALID_CONFIG,
        NODE_ENV: 'production',
        PUBLIC_BASE_URL: 'http://api.example.com',
      }),
    ).toThrow(/it must use https/);
  });

  it('refuses a non-absolute value under NODE_ENV=production', () => {
    expect(() =>
      validateEnv({
        ...VALID_CONFIG,
        NODE_ENV: 'production',
        PUBLIC_BASE_URL: 'api.example.com',
      }),
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
        ...VALID_CONFIG,
        NODE_ENV: 'production',
        PUBLIC_BASE_URL: 'http://api.example.com',
      }),
    ).toThrow(/"http:\/\/api\.example\.com"/);
  });
});
