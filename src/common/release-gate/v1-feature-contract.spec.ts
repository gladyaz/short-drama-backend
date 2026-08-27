import { runProductionPreflight } from '../production-preflight/preflight';
import { buildStructuralV1Env } from './release-mode';
import { GateFinding } from './release-gate.types';
import {
  checkV1FeatureContract,
  V1_FEATURE_CONTRACT,
  V1_OPTIONAL_SOCIAL_MISSIONS,
  V1_REQUIRED_SOCIAL_MISSIONS,
} from './v1-feature-contract';

/**
 * THE V1 FEATURE CONTRACT.
 *
 * Every value in this file is synthetic. No real Meta credential, no real Red
 * Panda social account, no real host, and nothing here opens a connection,
 * reads a file or sends a message.
 */

const blockers = (findings: GateFinding[]): GateFinding[] =>
  findings.filter((finding) => finding.severity === 'BLOCKER');

const checkNamed = (findings: GateFinding[], fragment: string): GateFinding => {
  const match = findings.find((finding) => finding.check.includes(fragment));
  expect(match).toBeDefined();
  return match!;
};

describe('V1 feature contract — the valid posture', () => {
  it('CRITICAL: reports no blocker for the complete V1 posture', () => {
    expect(blockers(checkV1FeatureContract(buildStructuralV1Env()))).toEqual(
      [],
    );
  });

  it('CRITICAL: the structural fixture also clears the production preflight', () => {
    // The fixture is what CI mode grades. If it ever stopped satisfying the
    // preflight, every CI run would fail on the fixture rather than on the
    // code — the check would look strict while proving nothing.
    const report = runProductionPreflight(buildStructuralV1Env());

    expect(
      report.findings
        .filter((finding) => finding.severity === 'BLOCKER')
        .map((finding) => `${finding.check}: ${finding.detail}`),
    ).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('accepts a posture that simply never sets PAYMENTS_ENABLED', () => {
    const env = buildStructuralV1Env();
    delete env.PAYMENTS_ENABLED;

    // `configuration.ts` resolves anything that is not the literal "true" to
    // disabled, so demanding the literal "false" would refuse the commonest
    // correct posture there is.
    expect(blockers(checkV1FeatureContract(env))).toEqual([]);
  });
});

describe('V1 feature contract — each posture V1 must refuse', () => {
  it('BLOCKS a release with WhatsApp login disabled', () => {
    const env = { ...buildStructuralV1Env(), WHATSAPP_AUTH_ENABLED: 'false' };
    const finding = checkNamed(checkV1FeatureContract(env), 'WhatsApp login');

    expect(finding.severity).toBe('BLOCKER');
    expect(finding.detail).toContain('WHATSAPP_AUTH_ENABLED');
    expect(finding.detail).toContain('503');
  });

  it('BLOCKS a release with WhatsApp enabled but unset (not merely "false")', () => {
    const env = buildStructuralV1Env();
    delete env.WHATSAPP_AUTH_ENABLED;

    expect(
      checkNamed(checkV1FeatureContract(env), 'WhatsApp login').severity,
    ).toBe('BLOCKER');
  });

  it('BLOCKS a release with Rewards disabled', () => {
    const env = { ...buildStructuralV1Env(), REWARDS_ENABLED: 'false' };
    const finding = checkNamed(checkV1FeatureContract(env), 'Rewards');

    expect(finding.severity).toBe('BLOCKER');
    expect(finding.detail).toContain('no earn or spend loop');
  });

  it.each(
    V1_REQUIRED_SOCIAL_MISSIONS.map(
      (mission) => [mission.platform, mission] as const,
    ),
  )(
    'BLOCKS a release missing the %s social mission URL',
    (platform, mission) => {
      const env = buildStructuralV1Env();
      delete env[mission.envKey];

      const finding = checkNamed(
        checkV1FeatureContract(env),
        `${platform} mission`,
      );

      expect(finding.severity).toBe('BLOCKER');
      expect(finding.detail).toContain(mission.envKey);
      expect(finding.detail).toContain('not set');
    },
  );

  it('BLOCKS a required social URL that is set but points at the wrong platform', () => {
    const [first, second] = V1_REQUIRED_SOCIAL_MISSIONS;
    const env = buildStructuralV1Env();
    // Instagram's URL pasted into TikTok's variable: valid https, real host,
    // real profile path — and the wrong platform entirely.
    env[second.envKey] = env[first.envKey];

    const finding = checkNamed(
      checkV1FeatureContract(env),
      `${second.platform} mission`,
    );

    expect(finding.severity).toBe('BLOCKER');
    expect(finding.detail).toContain('WRONG_HOST');
  });

  it('BLOCKS entitlement mode, including the unset default', () => {
    for (const mode of ['entitlement', undefined]) {
      const env = buildStructuralV1Env();
      if (mode === undefined) {
        delete env.CONTENT_ACCESS_MODE;
      } else {
        env.CONTENT_ACCESS_MODE = mode;
      }

      const finding = checkNamed(checkV1FeatureContract(env), 'Free catalog');

      expect(finding.severity).toBe('BLOCKER');
      expect(finding.detail).toContain('permanently unplayable');
    }
  });

  it('BLOCKS a release with payments enabled', () => {
    const env = { ...buildStructuralV1Env(), PAYMENTS_ENABLED: 'true' };
    const finding = checkNamed(checkV1FeatureContract(env), 'No payments');

    expect(finding.severity).toBe('BLOCKER');
    expect(finding.detail).toContain('purchase surface');
  });

  it('does NOT block a missing optional social mission', () => {
    // Facebook is `requiredForV1: false`. A release is never held up for a
    // platform the product never asked for.
    const env = buildStructuralV1Env();

    for (const mission of V1_OPTIONAL_SOCIAL_MISSIONS) {
      expect(env[mission.envKey]).toBeUndefined();
    }

    expect(blockers(checkV1FeatureContract(env))).toEqual([]);
  });

  it('warns — never blocks — on Google sign-in being off', () => {
    const env = { ...buildStructuralV1Env(), GOOGLE_AUTH_ENABLED: 'false' };
    const finding = checkNamed(checkV1FeatureContract(env), 'Google login');

    expect(finding.severity).toBe('WARNING');
    expect(blockers(checkV1FeatureContract(env))).toEqual([]);
  });
});

/**
 * THE POSTURES THE GATE REFUSES THROUGH ITS PREFLIGHT STEP.
 *
 * These are not feature-contract rules — they are boot-contract and preflight
 * rules — but the release gate is the command an engineer actually runs, so
 * the scenarios are pinned here against the same structural fixture the gate
 * grades in CI. If any of them ever stopped blocking, a release carrying it
 * would pass `npm run release:gate` with no blockers at all.
 */
describe('release gate — postures refused via the preflight step', () => {
  it('CRITICAL: BLOCKS the fake WhatsApp OTP provider in production', () => {
    // The fake provider delivers NO message and retains plaintext codes in
    // memory. A release shipping it would answer 202 to every OTP request and
    // send nothing.
    const report = runProductionPreflight({
      ...buildStructuralV1Env(),
      WHATSAPP_OTP_PROVIDER_DRIVER: 'fake',
    });

    expect(report.ok).toBe(false);
    const blocker = report.findings.find(
      (finding) =>
        finding.severity === 'BLOCKER' && finding.check === 'WhatsApp sign-in',
    );
    expect(blocker?.detail).toContain('delivers NO message');
  });

  it('BLOCKS an unimplemented WhatsApp driver', () => {
    const report = runProductionPreflight({
      ...buildStructuralV1Env(),
      WHATSAPP_OTP_PROVIDER_DRIVER: 'twilio',
    });

    expect(report.ok).toBe(false);
  });

  it('BLOCKS a cloud-api driver missing its sender credentials, naming no value', () => {
    const env = buildStructuralV1Env();
    const token = env.WHATSAPP_CLOUD_API_ACCESS_TOKEN!;
    env.WHATSAPP_CLOUD_API_ACCESS_TOKEN = '';

    const report = runProductionPreflight(env);

    expect(report.ok).toBe(false);
    expect(JSON.stringify(report.findings)).toContain(
      'WHATSAPP_CLOUD_API_ACCESS_TOKEN',
    );
    // A preflight report is exactly the kind of output that gets pasted into
    // a chat window.
    expect(JSON.stringify(report.findings)).not.toContain(token);
  });

  it.each([
    ['cleartext', 'http://api.redpanda-not-a-real-domain.app'],
    ['loopback', 'https://localhost:3000'],
    ['LAN', 'https://192.168.1.50:3000'],
    ['placeholder domain', 'https://api.example.com'],
  ])('CRITICAL: BLOCKS an unsafe %s PUBLIC_BASE_URL', (_kind, url) => {
    const report = runProductionPreflight({
      ...buildStructuralV1Env(),
      PUBLIC_BASE_URL: url,
    });

    expect(report.ok).toBe(false);
  });

  it('BLOCKS a development-only variable that arms a destructive path', () => {
    // DATABASE_URL_TEST is the declaration that arms the retention job's
    // destructive --commit path against a database.
    const report = runProductionPreflight({
      ...buildStructuralV1Env(),
      DATABASE_URL_TEST: 'postgresql://user:pass@db.internal:5432/anything',
    });

    expect(report.ok).toBe(false);
  });

  it('BLOCKS dev tools being enabled', () => {
    expect(
      runProductionPreflight({
        ...buildStructuralV1Env(),
        DEV_TOOLS_ENABLED: 'true',
      }).ok,
    ).toBe(false);
  });
});

describe('V1 feature contract — advisory mode', () => {
  it('downgrades every blocker to a warning, and invents none', () => {
    const broken = {
      ...buildStructuralV1Env(),
      WHATSAPP_AUTH_ENABLED: 'false',
      REWARDS_ENABLED: 'false',
      CONTENT_ACCESS_MODE: 'entitlement',
      PAYMENTS_ENABLED: 'true',
    };

    const blocking = checkV1FeatureContract(broken, 'blocking');
    const advisory = checkV1FeatureContract(broken, 'advisory');

    expect(blockers(blocking).length).toBeGreaterThan(0);
    expect(blockers(advisory)).toEqual([]);

    // Same checks, same order, same reasons — only the severity moves.
    expect(advisory.map((f) => f.check)).toEqual(blocking.map((f) => f.check));
    expect(advisory.map((f) => f.detail)).toEqual(
      blocking.map((f) => f.detail),
    );
  });
});

/**
 * THE ANTI-DRIFT PROPERTY, and the reason this contract is allowed to exist
 * beside `production-preflight/preflight.ts` at all.
 *
 * Two modules that independently encode the same policy will eventually
 * disagree, and the disagreement will be invisible — one will keep passing a
 * posture the other has started to refuse. So rather than trusting review to
 * keep them aligned, this asserts it: for every BLOCKING requirement in the
 * contract, violating it must ALSO produce a preflight blocker.
 *
 * PAYMENTS IS THE ONE DOCUMENTED EXCEPTION, in the strict direction. The
 * preflight WARNS on `PAYMENTS_ENABLED=true` (a payments-enabled backend
 * boots fine, which is all a boot-readiness tool claims to judge); the
 * release gate BLOCKS it (V1 is specified to ship no purchase flow). The test
 * pins that asymmetry so it stays deliberate.
 */
describe('V1 feature contract — cannot drift from the production preflight', () => {
  const violate = (envKey: string): Record<string, string | undefined> => {
    const env = buildStructuralV1Env();
    // Every contract flag is an exact-string flag, so a value that is
    // neither the expected one nor absent violates all of them.
    env[envKey] = 'definitely-not-the-expected-value';
    return env;
  };

  it.each(
    V1_FEATURE_CONTRACT.filter(
      (requirement) =>
        requirement.strength === 'blocking' &&
        requirement.id !== 'payments-disabled',
    ).map((requirement) => [requirement.id, requirement.envKey] as const),
  )('a %s violation is refused by the preflight too', (_id, envKey) => {
    const env = violate(envKey);

    expect(blockers(checkV1FeatureContract(env)).length).toBeGreaterThan(0);
    expect(runProductionPreflight(env).blockers).toBeGreaterThan(0);
  });

  it.each(
    V1_REQUIRED_SOCIAL_MISSIONS.map(
      (mission) => [mission.platform, mission.envKey] as const,
    ),
  )(
    'a missing %s mission is refused by the preflight too',
    (_platform, envKey) => {
      const env = buildStructuralV1Env();
      delete env[envKey];

      expect(blockers(checkV1FeatureContract(env)).length).toBeGreaterThan(0);
      expect(runProductionPreflight(env).blockers).toBeGreaterThan(0);
    },
  );

  /**
   * THE ONE ASYMMETRY, pinned precisely.
   *
   * A payments-enabled release that is otherwise COMPLETE — a Midtrans server
   * key supplied, so `validatePaymentsConfig` is satisfied and the process
   * genuinely boots — is a configuration the preflight calls clean, because
   * "will it boot and be wrong" is the only question a boot-readiness tool
   * asks. The release gate blocks it anyway, because "is this V1" is a
   * different question and V1 is specified to ship no purchase flow.
   *
   * The Midtrans key below is a synthetic literal. Supplying it is what makes
   * this test prove the asymmetry rather than merely re-discovering that an
   * INCOMPLETE payments configuration fails the boot contract — which it
   * does, and which is a different fact, asserted separately below.
   */
  it('DOCUMENTED ASYMMETRY: a bootable payments posture blocks the gate and only warns the preflight', () => {
    const env = {
      ...buildStructuralV1Env(),
      PAYMENTS_ENABLED: 'true',
      MIDTRANS_SERVER_KEY: 'release-gate-structural-fixture-midtrans-not-real',
    };

    expect(blockers(checkV1FeatureContract(env)).length).toBe(1);

    const preflight = runProductionPreflight(env);
    expect(preflight.blockers).toBe(0);
    expect(
      preflight.findings.some(
        (finding) =>
          finding.severity === 'WARNING' && finding.check === 'payments',
      ),
    ).toBe(true);
  });

  it('an INCOMPLETE payments posture is refused by both, via the boot contract', () => {
    // PAYMENTS_ENABLED=true with no MIDTRANS_SERVER_KEY does not boot at all,
    // so here the two tools agree — for different reasons, both correct.
    const env = { ...buildStructuralV1Env(), PAYMENTS_ENABLED: 'true' };

    expect(blockers(checkV1FeatureContract(env)).length).toBe(1);
    expect(runProductionPreflight(env).blockers).toBeGreaterThan(0);
  });

  it('the required social platforms are read from the catalog, not re-listed', () => {
    expect(V1_REQUIRED_SOCIAL_MISSIONS.map((m) => m.platform)).toEqual([
      'INSTAGRAM',
      'TIKTOK',
      'YOUTUBE',
    ]);
    expect(V1_OPTIONAL_SOCIAL_MISSIONS.map((m) => m.platform)).toEqual([
      'FACEBOOK',
    ]);
  });
});
