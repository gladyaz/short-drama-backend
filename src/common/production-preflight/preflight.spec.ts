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
/**
 * A COMPLETE, SHIPPABLE RED PANDA V1 PRODUCTION POSTURE — which is a stronger
 * thing than it was before the V1 integration, and deliberately so.
 *
 * Both feature branches shipped this fixture WITHOUT their own feature in it,
 * because on a feature branch "V1 requires WhatsApp login" is an assertion the
 * branch has no standing to make. Integrated, it is settled: V1 is free
 * content + ads + rewards + Google + WhatsApp, so a configuration missing
 * WhatsApp transport or the rewards earn loop is no longer "complete", and
 * every `ok === true` assertion in this file would be certifying a release
 * that is not V1 if this fixture stayed minimal.
 *
 * Each negative case below therefore SUBTRACTS from a good posture rather
 * than adding to an incomplete one — which is also why the WhatsApp cases now
 * pass `undefined` explicitly.
 *
 * GOOGLE SIGN-IN IS DELIBERATELY ABSENT: it warns rather than blocks, and one
 * of the assertions below pins exactly that.
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
  // WHATSAPP LOGIN V1 — required. Fixture values only; none of these is a
  // real Meta credential and none is ever sent anywhere by this suite.
  WHATSAPP_AUTH_ENABLED: 'true',
  WHATSAPP_OTP_PROVIDER_DRIVER: 'cloud-api',
  WHATSAPP_CLOUD_API_PHONE_NUMBER_ID: '111122223333444',
  WHATSAPP_CLOUD_API_ACCESS_TOKEN: 'spec-fixture-token',
  WHATSAPP_CLOUD_API_TEMPLATE_NAME: 'red_panda_login_otp',
  WHATSAPP_CLOUD_API_TEMPLATE_LANGUAGE: 'id',
  // REWARDS V1 — required, with the three platforms V1 specifies. Facebook is
  // left unset on purpose: it must NOT be required.
  REWARDS_ENABLED: 'true',
  REWARDS_SOCIAL_INSTAGRAM_URL: 'https://www.instagram.com/redpanda',
  REWARDS_SOCIAL_TIKTOK_URL: 'https://www.tiktok.com/@redpanda',
  REWARDS_SOCIAL_YOUTUBE_URL: 'https://www.youtube.com/@redpanda',
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

    /**
     * WHATSAPP LOGIN V1 — the named READY/BLOCKER verdict Phase 9 asks for.
     *
     * Every BLOCKER here is also refused by `validateEnv`, and the
     * `boot contract` assertions below prove that rather than assuming it:
     * the boot contract is the enforcement, and this check is the legible
     * per-feature reading of it an operator gets before spending a deploy.
     */
    describe('WhatsApp sign-in', () => {
      const CLOUD_API_ENV = {
        ...VALID_PRODUCTION_ENV,
        WHATSAPP_AUTH_ENABLED: 'true',
        WHATSAPP_OTP_PROVIDER_DRIVER: 'cloud-api',
        WHATSAPP_CLOUD_API_PHONE_NUMBER_ID: '111122223333444',
        WHATSAPP_CLOUD_API_ACCESS_TOKEN: 'spec-fixture-token',
        WHATSAPP_CLOUD_API_TEMPLATE_NAME: 'red_panda_login_otp',
        WHATSAPP_CLOUD_API_TEMPLATE_LANGUAGE: 'id',
      };

      it('BLOCKS a release with WhatsApp login not enabled — V1 requires it', () => {
        const env = {
          ...VALID_PRODUCTION_ENV,
          WHATSAPP_AUTH_ENABLED: 'false',
        };

        expect(severityOf(env, 'WhatsApp sign-in')).toEqual(['BLOCKER']);
        // THE POINT OF THE WHOLE CHECK: a V1 candidate with no WhatsApp
        // transport must not be able to report itself ready.
        expect(runProductionPreflight(env).ok).toBe(false);
        // ...and it is a RELEASE rule, not a boot rule — the process still
        // starts, which is what keeps development and test working with no
        // Meta credentials at all.
        expect(severityOf(env, 'boot contract')).not.toContain('BLOCKER');
      });

      it('BLOCKS a release with WHATSAPP_AUTH_ENABLED unset entirely', () => {
        const env = {
          ...VALID_PRODUCTION_ENV,
          WHATSAPP_AUTH_ENABLED: undefined,
        };

        expect(severityOf(env, 'WhatsApp sign-in')).toEqual(['BLOCKER']);
        expect(runProductionPreflight(env).ok).toBe(false);
      });

      it('BLOCKS the fake driver, which cannot start in production', () => {
        const env = {
          ...VALID_PRODUCTION_ENV,
          WHATSAPP_AUTH_ENABLED: 'true',
          WHATSAPP_OTP_PROVIDER_DRIVER: 'fake',
        };

        expect(severityOf(env, 'WhatsApp sign-in')).toEqual(['BLOCKER']);
        expect(runProductionPreflight(env).ok).toBe(false);
        // ...and the boot contract independently proves it.
        expect(severityOf(env, 'boot contract')).toContain('BLOCKER');
      });

      it('BLOCKS an enabled provider with no driver named', () => {
        const env = {
          ...VALID_PRODUCTION_ENV,
          WHATSAPP_AUTH_ENABLED: 'true',
          WHATSAPP_OTP_PROVIDER_DRIVER: undefined,
        };

        expect(severityOf(env, 'WhatsApp sign-in')).toEqual(['BLOCKER']);
        expect(severityOf(env, 'boot contract')).toContain('BLOCKER');
      });

      it('BLOCKS a driver that is not implemented', () => {
        const env = {
          ...VALID_PRODUCTION_ENV,
          WHATSAPP_AUTH_ENABLED: 'true',
          WHATSAPP_OTP_PROVIDER_DRIVER: 'twilio',
        };

        expect(severityOf(env, 'WhatsApp sign-in')).toEqual(['BLOCKER']);
        expect(severityOf(env, 'boot contract')).toContain('BLOCKER');
      });

      it.each([
        'WHATSAPP_CLOUD_API_PHONE_NUMBER_ID',
        'WHATSAPP_CLOUD_API_ACCESS_TOKEN',
        'WHATSAPP_CLOUD_API_TEMPLATE_NAME',
        'WHATSAPP_CLOUD_API_TEMPLATE_LANGUAGE',
      ])('BLOCKS cloud-api with %s missing, naming the variable', (key) => {
        const env = { ...CLOUD_API_ENV, [key]: undefined };

        expect(severityOf(env, 'WhatsApp sign-in')).toEqual(['BLOCKER']);
        expect(
          runProductionPreflight(env).findings.find(
            (f) => f.check === 'WhatsApp sign-in',
          )?.detail,
        ).toContain(key);
      });

      it('reports READY when the cloud-api sender is fully configured', () => {
        expect(severityOf(CLOUD_API_ENV, 'WhatsApp sign-in')).toEqual(['PASS']);
        expect(runProductionPreflight(CLOUD_API_ENV).ok).toBe(true);
        expect(severityOf(CLOUD_API_ENV, 'boot contract')).not.toContain(
          'BLOCKER',
        );
      });

      it('says plainly that READY is structural, not proof of delivery', () => {
        const detail =
          runProductionPreflight(CLOUD_API_ENV).findings.find(
            (f) => f.check === 'WhatsApp sign-in',
          )?.detail ?? '';

        expect(detail).toContain('STRUCTURAL ONLY');
        expect(detail).toMatch(/template is approved/);
      });

      it('CRITICAL: never prints the access token, in any posture', () => {
        for (const env of [
          CLOUD_API_ENV,
          { ...CLOUD_API_ENV, WHATSAPP_CLOUD_API_TEMPLATE_NAME: undefined },
        ]) {
          const report = JSON.stringify(runProductionPreflight(env));
          expect(report).not.toContain('spec-fixture-token');
        }
      });
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

  /**
   * Work unit "REWARDS V1 EARN AND SPEND": V1 ships free content + ads +
   * rewards, so a release with no earn loop, or with social missions still
   * pointing at a template handle, is worth stating before it ships rather
   * than discovering afterwards.
   */
  describe('rewards posture', () => {
    const REWARDS_ON: EnvRecord = {
      ...VALID_PRODUCTION_ENV,
      REWARDS_ENABLED: 'true',
      REWARDS_SOCIAL_INSTAGRAM_URL: 'https://www.instagram.com/redpanda',
      REWARDS_SOCIAL_TIKTOK_URL: 'https://www.tiktok.com/@redpanda',
      REWARDS_SOCIAL_YOUTUBE_URL: 'https://www.youtube.com/@redpanda',
    };

    it('BLOCKS a release with rewards off — it has no earn loop at all', () => {
      const env = { ...VALID_PRODUCTION_ENV, REWARDS_ENABLED: 'false' };

      expect(severityOf(env, 'rewards')).toEqual(['BLOCKER']);
      // V1 IS SPECIFIED AS free content + ads + REWARDS, so this is a defect
      // in the release, not a posture to be confirmed by hand.
      expect(runProductionPreflight(env).ok).toBe(false);
      // A RELEASE rule, not a boot rule: the process still starts.
      expect(severityOf(env, 'boot contract')).not.toContain('BLOCKER');
    });

    it('PASSES a fully configured V1 rewards posture', () => {
      expect(severityOf(REWARDS_ON, 'social missions')).toEqual(['PASS']);
      expect(runProductionPreflight(REWARDS_ON).ok).toBe(true);
    });

    it('states plainly that a social mission is user-confirmed, not verified', () => {
      const finding = runProductionPreflight(REWARDS_ON).findings.find(
        (f) => f.check === 'social missions',
      );

      // The report an operator reads before shipping must not let them
      // believe the backend verifies a follow.
      expect(finding?.detail).toMatch(/USER-CONFIRMED/);
      expect(finding?.detail).toMatch(/no platform verifies a follow/i);
    });

    it('BLOCKS when rewards are on but no social mission is configured', () => {
      const env = {
        ...VALID_PRODUCTION_ENV,
        REWARDS_ENABLED: 'true',
        REWARDS_SOCIAL_INSTAGRAM_URL: undefined,
        REWARDS_SOCIAL_TIKTOK_URL: undefined,
        REWARDS_SOCIAL_YOUTUBE_URL: undefined,
      };

      expect(severityOf(env, 'social missions')).toEqual(['BLOCKER']);
      expect(runProductionPreflight(env).ok).toBe(false);
    });

    it.each([
      'REWARDS_SOCIAL_INSTAGRAM_URL',
      'REWARDS_SOCIAL_TIKTOK_URL',
      'REWARDS_SOCIAL_YOUTUBE_URL',
    ])('BLOCKS when only %s is missing, and names it', (key) => {
      // Partial configuration is the realistic failure: three variables to
      // fill in, one forgotten, and the tile silently never appears.
      const env = { ...VALID_PRODUCTION_ENV, [key]: undefined };

      expect(severityOf(env, 'social missions')).toEqual(['BLOCKER']);
      expect(
        runProductionPreflight(env).findings.find(
          (f) => f.check === 'social missions',
        )?.detail,
      ).toContain(key);
    });

    /**
     * FACEBOOK IS NOT A V1 REQUIREMENT. Its tile exists only because the
     * foundation slice already served it; requiring a platform the product
     * never asked for would block releases for no reason.
     */
    it('does NOT require Facebook — the V1 three are enough to pass', () => {
      expect(VALID_PRODUCTION_ENV.REWARDS_SOCIAL_FACEBOOK_URL).toBeUndefined();
      expect(severityOf(VALID_PRODUCTION_ENV, 'social missions')).toEqual([
        'PASS',
      ]);
      expect(runProductionPreflight(VALID_PRODUCTION_ENV).ok).toBe(true);
    });

    it('CRITICAL: BLOCKS a social URL still carrying a template handle', () => {
      // `https://www.instagram.com/your-handle` is a valid https URL on the
      // right platform with a non-empty profile path, so the boot contract
      // accepts it. It is also an account Red Panda does not own — and users
      // would be paid for visiting it.
      const env = {
        ...REWARDS_ON,
        REWARDS_SOCIAL_INSTAGRAM_URL: 'https://www.instagram.com/your-handle',
      };
      const report = runProductionPreflight(env);
      const finding = report.findings.find((f) =>
        f.check.includes('REWARDS_SOCIAL_INSTAGRAM_URL placeholder'),
      );

      expect(finding?.severity).toBe('BLOCKER');
      expect(report.ok).toBe(false);
      // The boot contract is NOT what catches this — that is the whole reason
      // the check exists here.
      expect(severityOf(env, 'boot contract')).toEqual(['PASS']);
    });

    it('BLOCKS a template handle written with the platform @ prefix', () => {
      const env = {
        ...REWARDS_ON,
        REWARDS_SOCIAL_TIKTOK_URL: 'https://www.tiktok.com/@your-handle',
      };

      expect(runProductionPreflight(env).ok).toBe(false);
    });

    it('BLOCKS a malformed social URL through the boot contract', () => {
      const env = {
        ...REWARDS_ON,
        REWARDS_SOCIAL_YOUTUBE_URL: 'https://youtube.evil.example/redpanda',
      };

      expect(severityOf(env, 'boot contract')).toEqual(['BLOCKER']);
      expect(runProductionPreflight(env).ok).toBe(false);
    });
  });
});
