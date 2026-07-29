import { validateEnv } from './env.validation';

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
