import { validateEnv } from '../../config/env.validation';
import { SOCIAL_MISSION_DEFINITIONS } from '../../rewards/social-missions.constants';
import {
  isPlaceholderHostname,
  runProductionPreflight,
} from '../production-preflight/preflight';
import {
  buildStructuralV1Env,
  isReleaseGateMode,
  RELEASE_GATE_MODES,
  resolveReleaseGateMode,
  STRUCTURAL_DATABASE_URL,
  structuralSocialUrl,
} from './release-mode';

/**
 * RELEASE GATE MODES.
 *
 * Every value here is synthetic. Nothing in this file opens a connection or
 * reads the ambient environment.
 */

describe('release gate modes — the three questions', () => {
  it.each(RELEASE_GATE_MODES)('recognises %s', (mode) => {
    expect(isReleaseGateMode(mode)).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isReleaseGateMode('staging')).toBe(false);
    expect(isReleaseGateMode('')).toBe(false);
  });

  it('CRITICAL: CI mode ignores the ambient environment entirely', () => {
    // The load-bearing property: a CI verdict is a fact about the COMMIT, and
    // cannot be changed by whatever the runner happens to export.
    const hostile = {
      NODE_ENV: 'development',
      WHATSAPP_AUTH_ENABLED: 'false',
      REWARDS_ENABLED: 'false',
      CONTENT_ACCESS_MODE: 'entitlement',
      PAYMENTS_ENABLED: 'true',
      DEV_TOOLS_ENABLED: 'true',
    };

    const resolved = resolveReleaseGateMode('ci', hostile);

    expect(resolved.configSource).toBe('structural-fixture');
    expect(resolved.env).toEqual(buildStructuralV1Env());
    expect(resolved.env.NODE_ENV).toBe('production');
    expect(resolved.env.DEV_TOOLS_ENABLED).toBe('false');
  });

  it('LOCAL and PRODUCTION grade the ambient environment', () => {
    const ambient = {
      NODE_ENV: 'development',
      PUBLIC_BASE_URL: 'http://x:3000',
    };

    for (const mode of ['local', 'production'] as const) {
      const resolved = resolveReleaseGateMode(mode, ambient);
      expect(resolved.configSource).toBe('ambient-environment');
      expect(resolved.env).toEqual(ambient);
    }
  });

  it('copies the ambient record rather than aliasing it', () => {
    const ambient = { NODE_ENV: 'production' };
    const resolved = resolveReleaseGateMode('production', ambient);

    resolved.env.NODE_ENV = 'mutated';
    expect(ambient.NODE_ENV).toBe('production');
  });

  it('is advisory ONLY on a developer laptop', () => {
    expect(resolveReleaseGateMode('local', {}).policyEnforcement).toBe(
      'advisory',
    );
    expect(resolveReleaseGateMode('ci', {}).policyEnforcement).toBe('blocking');
    expect(resolveReleaseGateMode('production', {}).policyEnforcement).toBe(
      'blocking',
    );
  });

  it('CRITICAL: every mode states what it does NOT prove', () => {
    for (const mode of RELEASE_GATE_MODES) {
      const { claim } = resolveReleaseGateMode(mode, {});
      expect(claim).toMatch(/proves? (?:NOTHING|nothing|still nothing)|prove/);
      expect(claim.length).toBeGreaterThan(60);
    }

    // The CI claim in particular must never be readable as an external
    // verification, because CI is the run people quote.
    expect(resolveReleaseGateMode('ci', {}).claim).toContain('CODE-VALID');
    expect(resolveReleaseGateMode('ci', {}).claim).toContain('NOTHING');
  });
});

describe('release gate modes — the structural fixture', () => {
  const env = buildStructuralV1Env();

  it('CRITICAL: boots — validateEnv accepts it', () => {
    expect(() => validateEnv({ ...env })).not.toThrow();
  });

  it('CRITICAL: its hostnames are not placeholders the preflight would block', () => {
    // A fixture that tripped the placeholder rule would make CI fail on the
    // fixture rather than on the code, turning a real check into noise.
    const hostnames = [
      new URL(env.PUBLIC_BASE_URL!).hostname,
      new URL(env.OBJECT_STORAGE_ENDPOINT!).hostname,
      ...SOCIAL_MISSION_DEFINITIONS.filter((m) => m.requiredForV1).map(
        (m) => new URL(env[m.envKey]!).hostname,
      ),
    ];

    for (const hostname of hostnames) {
      expect(isPlaceholderHostname(hostname)).toBe(false);
    }
  });

  it('CRITICAL: no value could be mistaken for a real credential', () => {
    for (const key of [
      'JWT_ACCESS_SECRET',
      'JWT_REFRESH_SECRET',
      'AUTH_AUDIT_IP_HASH_SECRET',
      'WHATSAPP_CLOUD_API_ACCESS_TOKEN',
    ]) {
      expect(env[key]).toContain('release-gate-structural-fixture');
      expect(env[key]).toContain('not-real');
    }

    expect(env.PUBLIC_BASE_URL).toContain('not-a-real-host');
  });

  it('keeps the three auth secrets distinct, as the boot contract requires', () => {
    const secrets = [
      env.JWT_ACCESS_SECRET,
      env.JWT_REFRESH_SECRET,
      env.AUTH_AUDIT_IP_HASH_SECRET,
    ];
    expect(new Set(secrets).size).toBe(3);
  });

  it('populates exactly the V1-required social missions, and no others', () => {
    for (const mission of SOCIAL_MISSION_DEFINITIONS) {
      if (mission.requiredForV1) {
        expect(env[mission.envKey]).toBeDefined();
      } else {
        // Leaving the optional one unset is the posture the contract must
        // accept; populating it would hide a regression that made it
        // mandatory.
        expect(env[mission.envKey]).toBeUndefined();
      }
    }
  });

  it('builds each social URL on the platform’s own canonical host', () => {
    for (const mission of SOCIAL_MISSION_DEFINITIONS) {
      const url = new URL(structuralSocialUrl(mission));
      expect(mission.allowedHosts).toContain(url.hostname);
      expect(url.protocol).toBe('https:');
    }
  });

  it('CRITICAL: the structural DATABASE_URL can never resolve', () => {
    // It exists only because `prisma.config.ts` requires the variable to be
    // present. `.invalid` is guaranteed by RFC 6761 never to resolve, so a
    // command that unexpectedly tried to connect fails loudly instead of
    // quietly reaching something real.
    expect(new URL(STRUCTURAL_DATABASE_URL).hostname).toMatch(/\.invalid$/);
    expect(env.DATABASE_URL).toBe(STRUCTURAL_DATABASE_URL);
  });

  it('is deterministic — two builds are identical', () => {
    expect(buildStructuralV1Env()).toEqual(buildStructuralV1Env());
  });

  /**
   * THE FIXTURE MUST BE THE POSTURE THE RUNBOOK SPECIFIES, not the weakest
   * one that boots. `docs/V1_STAGING_RUNBOOK.md` §2 puts staging and
   * production on `STORAGE_DRIVER=r2` with Google sign-in on; a fixture on
   * `local`/no-Google would leave the R2 public-URL rules and the Google
   * client-id rule unexercised in every CI run.
   */
  it('CRITICAL: matches the runbook release matrix for staging/production', () => {
    expect(env.NODE_ENV).toBe('production');
    expect(env.STORAGE_DRIVER).toBe('r2');
    expect(env.GOOGLE_AUTH_ENABLED).toBe('true');
    expect(env.WHATSAPP_AUTH_ENABLED).toBe('true');
    expect(env.WHATSAPP_OTP_PROVIDER_DRIVER).toBe('cloud-api');
    expect(env.REWARDS_ENABLED).toBe('true');
    expect(env.CONTENT_ACCESS_MODE).toBe('free');
    expect(env.PAYMENTS_ENABLED).toBe('false');
    expect(env.DEV_TOOLS_ENABLED).toBe('false');
    expect(env.TRUST_PROXY_HOPS).toBe('1');
  });

  it('CRITICAL: sets no variable the preflight forbids in production', () => {
    // DATABASE_URL_TEST in particular arms the retention job's destructive
    // --commit path; the preflight blocks a release that carries it.
    for (const forbidden of [
      'DATABASE_URL_TEST',
      'RUN_R2_SMOKE',
      'RUN_R2_MEDIA_SMOKE',
      'RUN_R2_HLS_SMOKE',
      'SERIES_COVER_ORPHAN_APPLY_BUCKET',
    ]) {
      expect(env[forbidden]).toBeUndefined();
    }
  });

  it('produces a preflight report with no warnings either', () => {
    // Not a correctness requirement — a WARNING never blocks. But a warning
    // that describes the FIXTURE rather than the code appears on every CI run
    // forever, and that is exactly how a report's warnings stop being read.
    const report = runProductionPreflight(env);
    expect(
      report.findings
        .filter((finding) => finding.severity !== 'PASS')
        .map((finding) => `${finding.severity} ${finding.check}`),
    ).toEqual([]);
  });
});
