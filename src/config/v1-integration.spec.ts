import { validateEnv } from './env.validation';

/**
 * PLAY STORE V1 INTEGRATION SEAM.
 *
 * `feat/hls-transcoding-pipeline` and `feat/production-https-readiness`
 * evolved separately for 13 and 6 commits respectively and each added rules
 * to `validateEnv` without knowing about the other. Every rule is already
 * covered in isolation by `env.validation.spec.ts`; what nothing covered
 * until this merge is the INTERACTION — that turning on the V1 free-catalog
 * policy does not weaken a production URL gate, and that a production HLS
 * deployment has to satisfy both sets of rules at once.
 *
 * Every value here is a placeholder. No real secret, host, bucket or
 * credential appears, and nothing in this file opens a connection.
 */
const PRODUCTION_BASE: Record<string, unknown> = {
  NODE_ENV: 'production',
  PORT: '3000',
  PUBLIC_BASE_URL: 'https://api.redpanda-not-a-real-domain.app',
  STORAGE_ROOT: process.cwd(),
  CORS_ORIGINS: '',
  DATABASE_URL: 'postgresql://user:pass@db.internal:5432/redpanda',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  AUTH_AUDIT_IP_HASH_SECRET: 'c'.repeat(48),
  TRUST_PROXY_HOPS: '1',
  DEV_TOOLS_ENABLED: 'false',
};

/** A production deployment with the HLS pipeline switched on. */
const PRODUCTION_HLS: Record<string, unknown> = {
  ...PRODUCTION_BASE,
  TRANSCODE_ENABLED: 'true',
  REDIS_URL: 'redis://redis.internal:6379',
  HLS_TOKEN_SECRET: 'd'.repeat(48),
  HLS_GATEWAY_BASE_URL: 'https://hls.redpanda-not-a-real-domain.app',
};

/** A production deployment serving media from object storage. */
const PRODUCTION_R2: Record<string, unknown> = {
  ...PRODUCTION_BASE,
  STORAGE_DRIVER: 'r2',
  OBJECT_STORAGE_ENDPOINT: 'https://account.r2.cloudflarestorage.invalid',
  OBJECT_STORAGE_REGION: 'auto',
  OBJECT_STORAGE_BUCKET: 'redpanda-media',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'placeholder-access-key-id',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'placeholder-secret-access-key',
};

describe('V1 integration — CONTENT_ACCESS_MODE never weakens a production URL gate', () => {
  it.each(['entitlement', 'free', undefined])(
    'still refuses a cleartext PUBLIC_BASE_URL under CONTENT_ACCESS_MODE=%p',
    (mode) => {
      expect(() =>
        validateEnv({
          ...PRODUCTION_BASE,
          CONTENT_ACCESS_MODE: mode,
          PUBLIC_BASE_URL: 'http://api.redpanda-not-a-real-domain.app',
        }),
      ).toThrow(/it must use https/);
    },
  );

  it.each(['entitlement', 'free', undefined])(
    'still refuses a LAN HLS gateway under CONTENT_ACCESS_MODE=%p',
    (mode) => {
      expect(() =>
        validateEnv({
          ...PRODUCTION_HLS,
          CONTENT_ACCESS_MODE: mode,
          HLS_GATEWAY_BASE_URL: 'https://192.168.1.50:8787',
        }),
      ).toThrow(/private\/LAN address/);
    },
  );

  it('accepts the free catalog mode alongside a fully valid production config', () => {
    expect(() =>
      validateEnv({ ...PRODUCTION_HLS, CONTENT_ACCESS_MODE: 'free' }),
    ).not.toThrow();
  });

  /**
   * ORDERING ACROSS THE MERGE. `validateContentAccessMode` was placed ABOVE
   * the production URL block on purpose. If it had landed below it, a
   * malformed access mode would have been reported only AFTER the URL rules
   * passed — and, worse, a config that was wrong in both ways would have
   * reported the access mode and hidden the cleartext URL.
   */
  it('reports a cleartext production URL even when CONTENT_ACCESS_MODE is also malformed', () => {
    expect(() =>
      validateEnv({
        ...PRODUCTION_BASE,
        CONTENT_ACCESS_MODE: 'freemium',
        PUBLIC_BASE_URL: 'http://api.redpanda-not-a-real-domain.app',
      }),
    ).toThrow(/Invalid CONTENT_ACCESS_MODE/);
  });
});

describe('V1 integration — storage driver x environment', () => {
  it('accepts production + r2 with a public https endpoint', () => {
    expect(() => validateEnv({ ...PRODUCTION_R2 })).not.toThrow();
  });

  it('REFUSES production + r2 with a LAN endpoint (it would become the playbackUrl)', () => {
    expect(() =>
      validateEnv({
        ...PRODUCTION_R2,
        OBJECT_STORAGE_ENDPOINT: 'https://192.168.1.50:9000',
      }),
    ).toThrow(/private\/LAN address/);
  });

  it('accepts development + local (the default developer posture)', () => {
    expect(() =>
      validateEnv({
        ...PRODUCTION_BASE,
        NODE_ENV: 'development',
        PUBLIC_BASE_URL: 'http://192.168.110.144:3000',
        CORS_ORIGINS: 'http://localhost:8081',
      }),
    ).not.toThrow();
  });

  it('accepts development + r2 against a local MinIO-style endpoint', () => {
    expect(() =>
      validateEnv({
        ...PRODUCTION_R2,
        NODE_ENV: 'development',
        PUBLIC_BASE_URL: 'http://localhost:3000',
        CORS_ORIGINS: 'http://localhost:8081',
        OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
      }),
    ).not.toThrow();
  });

  /**
   * PRODUCTION + LOCAL IS ALLOWED AT BOOT, DELIBERATELY.
   *
   * It is tempting to refuse it as "Mac-dependent", but that would be wrong:
   * local-storage rows are served by THIS process at
   * `${PUBLIC_BASE_URL}/videos/:id/stream`, and `PUBLIC_BASE_URL` is already
   * forced to be a public https origin above. So the client-facing URL is
   * public either way — what local mode actually risks is the container's
   * STORAGE_ROOT being empty, which is a CONTENT problem no boot-time check
   * can see. `npm run production:preflight` raises it as a WARNING, which is
   * the honest severity: a deployment with a real persistent volume is
   * legitimate, and refusing to boot would break it.
   */
  it('allows production + local at boot, leaving the empty-STORAGE_ROOT risk to the preflight warning', () => {
    expect(() => validateEnv({ ...PRODUCTION_BASE })).not.toThrow();
  });
});

describe('V1 integration — HLS disabled is a valid V1 posture', () => {
  it('boots in production with TRANSCODE_ENABLED off and no gateway configured at all', () => {
    expect(() => validateEnv({ ...PRODUCTION_BASE })).not.toThrow();
  });

  it('ignores a leftover local gateway URL while the flag is off', () => {
    expect(() =>
      validateEnv({
        ...PRODUCTION_BASE,
        HLS_GATEWAY_BASE_URL: 'http://localhost:8787',
      }),
    ).not.toThrow();
  });

  it('starts enforcing that same URL the moment the flag is turned on', () => {
    expect(() =>
      validateEnv({
        ...PRODUCTION_HLS,
        HLS_GATEWAY_BASE_URL: 'http://localhost:8787',
      }),
    ).toThrow(/it must use https/);
  });
});
