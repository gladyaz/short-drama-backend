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
};

/**
 * Phase 10, work unit 10-B6: covers the new production fail-loud check
 * added alongside `DEV_TOOLS_ENABLED` (10-B5) — dev-only entitlement
 * grant/revoke routes must never be reachable in production, per the
 * security review requirement in the approved Phase 10 plan.
 */
describe('validateEnv — DEV_TOOLS_ENABLED / NODE_ENV interaction', () => {
  it('passes when DEV_TOOLS_ENABLED is unset', () => {
    expect(() => validateEnv({ ...VALID_CONFIG })).not.toThrow();
  });

  it('passes when DEV_TOOLS_ENABLED=true and NODE_ENV is not production', () => {
    expect(() =>
      validateEnv({
        ...VALID_CONFIG,
        DEV_TOOLS_ENABLED: 'true',
        NODE_ENV: 'development',
      }),
    ).not.toThrow();
  });

  it('throws when DEV_TOOLS_ENABLED=true and NODE_ENV=production', () => {
    expect(() =>
      validateEnv({
        ...VALID_CONFIG,
        DEV_TOOLS_ENABLED: 'true',
        NODE_ENV: 'production',
      }),
    ).toThrow(/DEV_TOOLS_ENABLED=true is not allowed when NODE_ENV=production/);
  });

  it('passes when DEV_TOOLS_ENABLED=false and NODE_ENV=production', () => {
    expect(() =>
      validateEnv({
        ...VALID_CONFIG,
        DEV_TOOLS_ENABLED: 'false',
        NODE_ENV: 'production',
      }),
    ).not.toThrow();
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
