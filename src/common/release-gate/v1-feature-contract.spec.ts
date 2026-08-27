import { runProductionPreflight } from '../production-preflight/preflight';
import { buildStructuralV1Env } from './release-mode';
import { GateFinding } from './release-gate.types';
import {
  checkV1FeatureContract,
  V1_FEATURE_CONTRACT,
  V1_OPTIONAL_SOCIAL_MISSIONS,
  V1_REQUIRED_SOCIAL_MISSIONS,
  V1FeatureRequirement,
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

  /**
   * GOOGLE LOGIN — the requirement this contract used to grade as
   * `recommended`, and the reason it did was tool agreement rather than
   * product policy: `preflight.ts` warned, so blocking here would have made
   * the gate the stricter of two tools meant to agree. The confirmed V1
   * contract requires Google login exactly as it requires WhatsApp login, and
   * the MOBILE release preflight has always treated it that way — so the old
   * severity let backend and mobile disagree about one candidate. Both tools
   * block now, and the anti-drift block at the end of this file proves it.
   */
  it('CRITICAL: BLOCKS a release with Google login disabled', () => {
    const env = { ...buildStructuralV1Env(), GOOGLE_AUTH_ENABLED: 'false' };
    const finding = checkNamed(checkV1FeatureContract(env), 'Google login');

    expect(finding.severity).toBe('BLOCKER');
    expect(finding.detail).toContain('GOOGLE_AUTH_ENABLED');
    expect(finding.detail).toContain('503');
  });

  it('BLOCKS a release with Google login unset (not merely "false")', () => {
    const env = buildStructuralV1Env();
    delete env.GOOGLE_AUTH_ENABLED;

    expect(
      checkNamed(checkV1FeatureContract(env), 'Google login').severity,
    ).toBe('BLOCKER');
  });

  it.each([
    // The rendered value, never the raw one — `describeClientIds` prints
    // `(unset)` for an absent variable and a COUNT for a present one, so a
    // report distinguishes "nobody set it" from "it was set to `,,`".
    ['unset', undefined, '(unset)'],
    ['blank', '   ', '0 non-empty client id(s)'],
    ['comma-only', ',,', '0 non-empty client id(s)'],
  ])(
    'CRITICAL: BLOCKS a release whose Google client ids are %s',
    (_label, value, rendered) => {
      const env = { ...buildStructuralV1Env(), GOOGLE_OAUTH_CLIENT_IDS: value };
      const finding = checkNamed(
        checkV1FeatureContract(env),
        'Google client ids',
      );

      expect(finding.severity).toBe('BLOCKER');
      expect(finding.detail).toContain('GOOGLE_OAUTH_CLIENT_IDS');
      expect(finding.detail).toContain(rendered);
    },
  );

  it('accepts a structurally valid Google posture, and claims nothing more', () => {
    const env = buildStructuralV1Env();
    const findings = checkV1FeatureContract(env);

    expect(checkNamed(findings, 'Google login').severity).toBe('PASS');
    expect(checkNamed(findings, 'Google client ids').severity).toBe('PASS');
    expect(blockers(findings)).toEqual([]);
  });

  it('never echoes a Google client id value in any posture', () => {
    // These ids are public by design and no client SECRET is read anywhere in
    // this codebase — but a release report is pasted into chat windows, and
    // the count is the whole of what this check graded.
    const env = buildStructuralV1Env();
    const ids = env.GOOGLE_OAUTH_CLIENT_IDS!;

    for (const candidate of [env, { ...env, GOOGLE_AUTH_ENABLED: 'false' }]) {
      expect(JSON.stringify(checkV1FeatureContract(candidate))).not.toContain(
        ids,
      );
    }
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
  /**
   * UNSETTING THE VARIABLE, rather than writing a wrong value into it.
   *
   * The earlier form wrote `'definitely-not-the-expected-value'` and leaned on
   * "every contract flag is an exact-string flag". `GOOGLE_OAUTH_CLIENT_IDS`
   * is not — any non-blank string satisfies it — so that form would have
   * quietly graded a SATISFIED posture and asserted a blocker that could never
   * appear. Unset violates every blocking requirement except
   * `payments-disabled`, which is excluded below for exactly that reason.
   *
   * The predicate is then re-run as an assertion, so a future requirement that
   * accepts "unset" fails loudly here instead of turning this into a test that
   * proves nothing.
   */
  const violate = (
    requirement: V1FeatureRequirement,
  ): Record<string, string | undefined> => {
    const env = buildStructuralV1Env();
    delete env[requirement.envKey];

    expect(requirement.satisfiedBy(env[requirement.envKey])).toBe(false);
    return env;
  };

  it.each(
    V1_FEATURE_CONTRACT.filter(
      (requirement) =>
        requirement.strength === 'blocking' &&
        requirement.id !== 'payments-disabled',
    ).map((requirement) => [requirement.id, requirement] as const),
  )('a %s violation is refused by the preflight too', (_id, requirement) => {
    const env = violate(requirement);

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

/**
 * THE BACKEND'S ANSWER TO "WHAT DOES V1 REQUIRE", ASSERTED AS A WHOLE.
 *
 * The tests above each grade one posture. This block grades the CONTRACT
 * ITSELF, because the defect it was written for was not a posture being
 * mis-graded — it was the backend and the mobile release preflight holding
 * DIFFERENT LISTS of what V1 requires, with Google on one list and not the
 * other. A per-posture test cannot catch that; only pinning the list can.
 */
describe('V1 feature contract — the required set, pinned', () => {
  it('CRITICAL: GOOGLE REQUIRED and WHATSAPP REQUIRED, both blocking', () => {
    const strengthOf = (id: string): string | undefined =>
      V1_FEATURE_CONTRACT.find((requirement) => requirement.id === id)
        ?.strength;

    expect(strengthOf('google-login')).toBe('blocking');
    expect(strengthOf('google-client-ids')).toBe('blocking');
    expect(strengthOf('whatsapp-login')).toBe('blocking');
  });

  it('CRITICAL: every V1 requirement is blocking — nothing is advisory', () => {
    // Google was the single `recommended` entry. Its promotion leaves the
    // list uniform, and a future entry that quietly reintroduced a
    // "recommended" V1 requirement would fail here rather than ship a
    // release rule the mobile side does not share.
    expect(
      V1_FEATURE_CONTRACT.filter(
        (requirement) => requirement.strength !== 'blocking',
      ).map((requirement) => requirement.id),
    ).toEqual([]);
  });

  it('pins the full contract, so an addition or removal is a deliberate diff', () => {
    expect(
      V1_FEATURE_CONTRACT.map((requirement) => [
        requirement.id,
        requirement.envKey,
      ]),
    ).toEqual([
      ['whatsapp-login', 'WHATSAPP_AUTH_ENABLED'],
      ['rewards', 'REWARDS_ENABLED'],
      ['free-catalog', 'CONTENT_ACCESS_MODE'],
      ['payments-disabled', 'PAYMENTS_ENABLED'],
      ['google-login', 'GOOGLE_AUTH_ENABLED'],
      ['google-client-ids', 'GOOGLE_OAUTH_CLIENT_IDS'],
    ]);
  });

  /**
   * THE OTHER RULES ARE UNTOUCHED BY THE GOOGLE ALIGNMENT, asserted rather
   * than assumed. A "make one thing stricter" change is exactly the kind that
   * loosens something else by accident.
   */
  it('leaves every non-Google rule at the severity it already had', () => {
    const severityWhen = (
      overrides: Record<string, string | undefined>,
      fragment: string,
    ): string =>
      checkNamed(
        checkV1FeatureContract({
          ...buildStructuralV1Env(),
          ...overrides,
        }),
        fragment,
      ).severity;

    expect(
      severityWhen({ WHATSAPP_AUTH_ENABLED: 'false' }, 'WhatsApp login'),
    ).toBe('BLOCKER');
    expect(severityWhen({ REWARDS_ENABLED: 'false' }, 'Rewards')).toBe(
      'BLOCKER',
    );
    expect(
      severityWhen({ CONTENT_ACCESS_MODE: 'entitlement' }, 'Free catalog'),
    ).toBe('BLOCKER');
    expect(severityWhen({ PAYMENTS_ENABLED: 'true' }, 'No payments')).toBe(
      'BLOCKER',
    );
    expect(severityWhen({}, 'optional social missions')).toBe('PASS');
  });

  /**
   * HLS is NOT a contract flag and must not become one. `TRANSCODE_ENABLED`
   * off is a valid V1 posture — HLS-ready rows fall back to their R2 source —
   * so the preflight passes it and the contract has no opinion at all.
   */
  it('leaves the HLS posture out of the contract and unblocked', () => {
    expect(
      V1_FEATURE_CONTRACT.some(
        (requirement) => requirement.envKey === 'TRANSCODE_ENABLED',
      ),
    ).toBe(false);

    // Graded on the NAMED `HLS pipeline` finding rather than on the report's
    // blocker count, because turning the pipeline on pulls in requirements
    // that are not about HLS grading at all (REDIS_URL, via the boot
    // contract). Those are the transcode module's own rules and this test has
    // no business asserting them.
    const hlsSeverity = (value: string): string =>
      runProductionPreflight({
        ...buildStructuralV1Env(),
        TRANSCODE_ENABLED: value,
        REDIS_URL: 'redis://release-gate.invalid:6379',
        HLS_GATEWAY_BASE_URL:
          'https://hls.release-gate-structural-fixture-not-a-real-host.app',
      }).findings.find((finding) => finding.check === 'HLS pipeline')!.severity;

    // Off is a valid V1 posture: HLS-ready rows fall back to their R2 source.
    expect(hlsSeverity('false')).toBe('PASS');
    // On is stated, never refused — the gateway and worker are facts no
    // configuration can prove.
    expect(hlsSeverity('true')).toBe('WARNING');
  });
});

/**
 * LOCAL AND TEST POSTURES SURVIVE THE PROMOTION — the property that keeps
 * this a RELEASE rule rather than a boot rule.
 *
 * A developer with no Google Cloud project must still be able to run the
 * gate, and `NODE_ENV=development` must still boot with the flag off. If
 * either stopped being true, this change would have moved a release policy
 * into the daily inner loop, which is not what was asked and is how a gate
 * starts being ignored.
 */
describe('V1 feature contract — the local/dev posture is still supported', () => {
  const laptop: Record<string, string | undefined> = {
    NODE_ENV: 'development',
    // No GOOGLE_AUTH_ENABLED, no GOOGLE_OAUTH_CLIENT_IDS — the shipped
    // default state of this repository.
  };

  it('CRITICAL: advisory mode raises no blocker for a laptop with no Google config', () => {
    const findings = checkV1FeatureContract(laptop, 'advisory');

    expect(blockers(findings)).toEqual([]);
    expect(checkNamed(findings, 'Google login').severity).toBe('WARNING');
    expect(checkNamed(findings, 'Google client ids').severity).toBe('WARNING');
  });

  it('states the same reason in advisory mode as in blocking mode', () => {
    const blocking = checkV1FeatureContract(laptop, 'blocking');
    const advisory = checkV1FeatureContract(laptop, 'advisory');

    // Only the severity moves — a developer and a release owner read the
    // identical sentence, which is what makes the advisory report worth
    // reading at all.
    expect(advisory.map((f) => f.check)).toEqual(blocking.map((f) => f.check));
    expect(advisory.map((f) => f.detail)).toEqual(
      blocking.map((f) => f.detail),
    );
  });
});
