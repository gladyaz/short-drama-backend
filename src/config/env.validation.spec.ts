import { validateEnv } from './env.validation';

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
