import {
  EnvRecord,
  isPlaceholderHostname,
  runProductionPreflight,
} from './preflight';

/**
 * Every value here is a placeholder. No real secret, hostname, bucket or
 * credential appears in this file, and the preflight itself never opens a
 * connection — these tests are pure in-memory evaluations of an env record.
 */
const VALID_PRODUCTION_ENV: EnvRecord = {
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

function severityOf(env: EnvRecord, check: string): string[] {
  return runProductionPreflight(env)
    .findings.filter((finding) => finding.check.includes(check))
    .map((finding) => finding.severity);
}

describe('isPlaceholderHostname', () => {
  it.each([
    'api.example.com',
    'example.com',
    'media.example.org',
    'bucket.example.invalid',
    'api.test',
    'gateway.localhost',
    'anything.example',
    'changeme.app',
    'your-domain.com',
    'placeholder.io',
  ])('flags the reserved/placeholder host %s', (host) => {
    expect(isPlaceholderHostname(host)).toBe(true);
  });

  /**
   * The rule matches whole labels and suffixes, never a loose substring —
   * a real domain that happens to contain one of these words must survive.
   */
  it.each([
    'api.redpanda.app',
    'todoapp.com',
    'exampleworks.com',
    'my-placeholders.dev',
    'testing.co.id',
  ])('does not flag the real-looking host %s', (host) => {
    expect(isPlaceholderHostname(host)).toBe(false);
  });
});

describe('runProductionPreflight', () => {
  it('passes a complete, production-valid configuration with no blockers', () => {
    const report = runProductionPreflight(VALID_PRODUCTION_ENV);

    expect(report.blockers).toBe(0);
    expect(report.ok).toBe(true);
  });

  it('never reports PASS for a configuration it blocks', () => {
    const report = runProductionPreflight({
      ...VALID_PRODUCTION_ENV,
      PUBLIC_BASE_URL: 'http://api.redpanda-not-a-real-domain.app',
    });

    expect(report.ok).toBe(false);
    expect(report.blockers).toBeGreaterThan(0);
  });

  describe('NODE_ENV', () => {
    it.each([undefined, '', 'development', 'test', 'Production', 'prod'])(
      'BLOCKS NODE_ENV=%p, because every production guard keys on the exact string',
      (nodeEnv) => {
        expect(
          severityOf(
            { ...VALID_PRODUCTION_ENV, NODE_ENV: nodeEnv },
            'NODE_ENV',
          ),
        ).toContain('BLOCKER');
      },
    );

    it('passes NODE_ENV=production', () => {
      expect(severityOf(VALID_PRODUCTION_ENV, 'NODE_ENV')).toEqual(['PASS']);
    });
  });

  /**
   * The boot contract is REUSED, not re-implemented, so the preflight can
   * never drift from what the process actually refuses to start with.
   */
  describe('boot contract', () => {
    it.each([
      [
        'a cleartext public base URL',
        { PUBLIC_BASE_URL: 'http://api.redpanda-not-a-real-domain.app' },
      ],
      [
        'a LAN public base URL',
        { PUBLIC_BASE_URL: 'https://192.168.1.5:3000' },
      ],
      [
        'a loopback public base URL',
        { PUBLIC_BASE_URL: 'https://localhost:3000' },
      ],
      ['a missing JWT secret', { JWT_ACCESS_SECRET: undefined }],
      ['two identical auth secrets', { JWT_REFRESH_SECRET: 'a'.repeat(48) }],
      ['a leftover dev CORS origin', { CORS_ORIGINS: 'http://localhost:5173' }],
      ['a wildcard CORS entry', { CORS_ORIGINS: '*' }],
      ['a malformed TRUST_PROXY_HOPS', { TRUST_PROXY_HOPS: 'one' }],
    ])('BLOCKS %s', (_label, override) => {
      expect(
        severityOf({ ...VALID_PRODUCTION_ENV, ...override }, 'boot contract'),
      ).toContain('BLOCKER');
    });

    it('reports the validator message verbatim so the fix is the same one the boot would demand', () => {
      const report = runProductionPreflight({
        ...VALID_PRODUCTION_ENV,
        PUBLIC_BASE_URL: 'http://api.redpanda-not-a-real-domain.app',
      });
      const finding = report.findings.find((f) => f.check === 'boot contract');

      expect(finding?.detail).toMatch(/it must use https/);
    });
  });

  /**
   * `env.validation.ts` CANNOT catch this: `https://api.example.com` is a
   * well-formed public https origin that resolves to nothing anyone owns.
   */
  describe('placeholder domains', () => {
    it('BLOCKS a documentation domain that every other rule accepts', () => {
      const env = {
        ...VALID_PRODUCTION_ENV,
        PUBLIC_BASE_URL: 'https://api.example.com',
      };

      // Proof that this is the ONLY thing wrong with it.
      expect(severityOf(env, 'boot contract')).toEqual(['PASS']);
      expect(severityOf(env, 'PUBLIC_BASE_URL placeholder')).toContain(
        'BLOCKER',
      );
    });

    /**
     * A PASS printed beside a BLOCKER for the same subject is how a report
     * loses an operator's trust.
     */
    it('does not also claim the public URL hostnames PASS when one is a placeholder', () => {
      const env = {
        ...VALID_PRODUCTION_ENV,
        PUBLIC_BASE_URL: 'https://api.example.com',
      };

      expect(severityOf(env, 'public URL hostnames')).toEqual([]);
    });

    it('claims the PASS when every active public URL is real', () => {
      expect(severityOf(VALID_PRODUCTION_ENV, 'public URL hostnames')).toEqual([
        'PASS',
      ]);
    });

    it('checks the storage endpoint only in r2 mode', () => {
      const local = {
        ...VALID_PRODUCTION_ENV,
        OBJECT_STORAGE_ENDPOINT: 'https://bucket.example.com',
      };
      expect(severityOf(local, 'OBJECT_STORAGE_ENDPOINT placeholder')).toEqual(
        [],
      );
    });

    it('checks the HLS gateway only when transcoding is enabled', () => {
      const off = {
        ...VALID_PRODUCTION_ENV,
        HLS_GATEWAY_BASE_URL: 'https://hls.example.com',
      };
      expect(severityOf(off, 'HLS_GATEWAY_BASE_URL placeholder')).toEqual([]);
    });
  });

  /**
   * This process never speaks TLS, so an https public origin implies a
   * terminator in front of it. A WARNING, not a BLOCKER — the right hop
   * count depends on a topology this code cannot see, and guessing wrong in
   * the other direction is the one that opens a forgery hole.
   */
  describe('reverse-proxy topology', () => {
    it('WARNS when PUBLIC_BASE_URL is https but TRUST_PROXY_HOPS is 0', () => {
      expect(
        severityOf(
          { ...VALID_PRODUCTION_ENV, TRUST_PROXY_HOPS: '0' },
          'TRUST_PROXY_HOPS',
        ),
      ).toEqual(['WARNING']);
    });

    it('WARNS when TRUST_PROXY_HOPS is unset entirely', () => {
      expect(
        severityOf(
          { ...VALID_PRODUCTION_ENV, TRUST_PROXY_HOPS: undefined },
          'TRUST_PROXY_HOPS',
        ),
      ).toEqual(['WARNING']);
    });

    it('passes when a hop count is configured', () => {
      expect(severityOf(VALID_PRODUCTION_ENV, 'TRUST_PROXY_HOPS')).toEqual([
        'PASS',
      ]);
    });

    it('never blocks on it — an availability problem must not gate a release the way a security hole does', () => {
      const report = runProductionPreflight({
        ...VALID_PRODUCTION_ENV,
        TRUST_PROXY_HOPS: '0',
      });
      expect(report.ok).toBe(true);
      expect(report.warnings).toBeGreaterThan(0);
    });
  });

  describe('secret hygiene', () => {
    it('WARNS about a short secret, naming the variable', () => {
      const report = runProductionPreflight({
        ...VALID_PRODUCTION_ENV,
        JWT_ACCESS_SECRET: 'short',
      });
      const finding = report.findings.find((f) => f.check === 'secret length');

      expect(finding?.severity).toBe('WARNING');
      expect(finding?.detail).toContain('JWT_ACCESS_SECRET');
    });

    /**
     * The whole report is serialized and searched: no finding, of any
     * severity, may ever contain a secret VALUE.
     */
    it('never prints a secret value anywhere in the report', () => {
      const sentinel = 'SENTINEL-SECRET-VALUE-DO-NOT-PRINT';
      const report = runProductionPreflight({
        ...VALID_PRODUCTION_ENV,
        JWT_ACCESS_SECRET: sentinel,
        JWT_REFRESH_SECRET: sentinel,
        AUTH_AUDIT_IP_HASH_SECRET: sentinel,
        MIDTRANS_SERVER_KEY: sentinel,
        OBJECT_STORAGE_SECRET_ACCESS_KEY: sentinel,
      });

      expect(JSON.stringify(report)).not.toContain(sentinel);
    });
  });

  describe('development-only variables', () => {
    it.each([
      'DATABASE_URL_TEST',
      'RUN_R2_SMOKE',
      'RUN_R2_MEDIA_SMOKE',
      'RUN_R2_HLS_SMOKE',
      'SERIES_COVER_ORPHAN_APPLY_BUCKET',
    ])('BLOCKS %s being set in production', (key) => {
      const report = runProductionPreflight({
        ...VALID_PRODUCTION_ENV,
        [key]: 'anything',
      });

      expect(report.ok).toBe(false);
      expect(report.findings.some((f) => f.check.startsWith(key))).toBe(true);
    });

    it('passes when none of them is set', () => {
      expect(
        severityOf(VALID_PRODUCTION_ENV, 'development-only variables'),
      ).toEqual(['PASS']);
    });
  });

  /**
   * Posture findings must never block: each is a choice an operator may
   * legitimately have made, and a preflight that refuses a release over
   * `GOOGLE_AUTH_ENABLED=false` is a preflight people learn to ignore.
   */
  describe('feature posture', () => {
    it('WARNS but does not block on local storage in production', () => {
      const report = runProductionPreflight(VALID_PRODUCTION_ENV);

      expect(severityOf(VALID_PRODUCTION_ENV, 'storage driver')).toEqual([
        'WARNING',
      ]);
      expect(report.ok).toBe(true);
    });

    it('passes on r2 storage', () => {
      expect(
        severityOf(
          { ...VALID_PRODUCTION_ENV, STORAGE_DRIVER: 'r2' },
          'storage driver',
        ),
      ).toEqual(['PASS']);
    });

    it('WARNS but does not block when Google sign-in is off', () => {
      expect(severityOf(VALID_PRODUCTION_ENV, 'Google sign-in')).toEqual([
        'WARNING',
      ]);
      expect(runProductionPreflight(VALID_PRODUCTION_ENV).ok).toBe(true);
    });

    it('WARNS that a WhatsApp production configuration cannot start at all', () => {
      const env = { ...VALID_PRODUCTION_ENV, WHATSAPP_AUTH_ENABLED: 'true' };

      expect(severityOf(env, 'WhatsApp sign-in')).toEqual(['WARNING']);
      // ...and the boot contract independently proves it, which is the point.
      expect(severityOf(env, 'boot contract')).toContain('BLOCKER');
    });

    it('WARNS that payments are out of V1 scope when enabled', () => {
      expect(
        severityOf(
          {
            ...VALID_PRODUCTION_ENV,
            PAYMENTS_ENABLED: 'true',
            MIDTRANS_SERVER_KEY: 'x'.repeat(40),
          },
          'payments',
        ),
      ).toEqual(['WARNING']);
    });

    /**
     * V1 INTEGRATION. The free-catalog policy changes nothing an operator
     * can observe from configuration — no URL moves, every route still
     * answers 200 — while deciding whether 25 premium episodes are payable
     * content. It must be stated, and it must never block: it is a
     * deliberate product posture, not a misconfiguration.
     */
    it('WARNS but does not block on CONTENT_ACCESS_MODE=free', () => {
      const env = { ...VALID_PRODUCTION_ENV, CONTENT_ACCESS_MODE: 'free' };

      expect(severityOf(env, 'content access mode')).toEqual(['WARNING']);
      expect(runProductionPreflight(env).ok).toBe(true);
    });

    it.each(['entitlement', undefined])(
      'passes CONTENT_ACCESS_MODE=%p, where per-row tiers are enforced',
      (mode) => {
        expect(
          severityOf(
            { ...VALID_PRODUCTION_ENV, CONTENT_ACCESS_MODE: mode },
            'content access mode',
          ),
        ).toEqual(['PASS']);
      },
    );

    /**
     * HLS OFF IS A VALID V1 POSTURE and must not be flagged as a problem —
     * HLS-ready rows fall back to their R2 source. Turning it ON is what
     * introduces things configuration cannot verify (a deployed gateway, a
     * running worker), so that is the direction that warns.
     */
    it('passes when the HLS pipeline is off, the shipped V1 default', () => {
      expect(severityOf(VALID_PRODUCTION_ENV, 'HLS pipeline')).toEqual([
        'PASS',
      ]);
    });

    it('WARNS but does not block when the HLS pipeline is on', () => {
      const env = {
        ...VALID_PRODUCTION_ENV,
        TRANSCODE_ENABLED: 'true',
        REDIS_URL: 'redis://redis.internal:6379',
        HLS_TOKEN_SECRET: 'd'.repeat(48),
        HLS_GATEWAY_BASE_URL: 'https://hls.redpanda-not-a-real-domain.app',
      };

      expect(severityOf(env, 'HLS pipeline')).toEqual(['WARNING']);
      expect(runProductionPreflight(env).ok).toBe(true);
    });

    it('BLOCKS DEV_TOOLS_ENABLED=true with a legible reason, not only a validator message', () => {
      const report = runProductionPreflight({
        ...VALID_PRODUCTION_ENV,
        DEV_TOOLS_ENABLED: 'true',
      });
      const finding = report.findings.find((f) => f.check === 'dev tools');

      expect(finding?.severity).toBe('BLOCKER');
      expect(finding?.detail).toMatch(/admin-role/);
    });
  });
});
