/**
 * THE RED PANDA V1 FEATURE CONTRACT — what "V1" means, written down once, in
 * a form a machine can check.
 *
 * The product statement is short: FREE CONTENT + ADS + REWARDS + GOOGLE LOGIN
 * + WHATSAPP LOGIN + HLS, and NO PAYMENT, NO SUBSCRIPTION, NO PREMIUM
 * PAYWALL. Every one of those clauses is a runtime flag, every flag has a
 * default, and every default is the opposite of what V1 needs for at least
 * one of them. A release that forgets one does not crash — it ships a dead
 * login button, an empty Rewards Center, or a catalog half of which can never
 * be played, and every other signal stays green.
 *
 * WHAT THIS FILE ADDS OVER `production-preflight/preflight.ts`, given that the
 * preflight already blocks most of these. Two things, and only two:
 *
 *   1. THE POLICY BECOMES DATA. `V1_FEATURE_CONTRACT` is a list a test can
 *      iterate, a document can render, and CI can diff — not a sequence of
 *      hand-written `if` statements whose collective meaning has to be
 *      reconstructed by reading them all.
 *
 *   2. PAYMENTS. The preflight WARNS on `PAYMENTS_ENABLED=true` because a
 *      preflight grades "will this boot and be wrong", and a payments-enabled
 *      backend boots fine. A RELEASE GATE grades "is this V1", and V1 is
 *      specified with no purchase flow of any kind, so here it BLOCKS.
 *
 * IT DOES NOT RE-DERIVE ANY RULE IT CAN IMPORT. The required social platforms
 * come from `SOCIAL_MISSION_DEFINITIONS[].requiredForV1`; each URL's shape is
 * judged by `rejectSocialUrl`; the flag semantics mirror `configuration.ts`
 * exactly. `v1-feature-contract.spec.ts` then asserts that every BLOCKING
 * requirement here is ALSO refused by the preflight — so the two can never
 * drift apart in silence, which a second hand-maintained copy of the policy
 * certainly would.
 */
import {
  rejectSocialUrl,
  SOCIAL_MISSION_DEFINITIONS,
  SocialMissionDefinition,
} from '../../rewards/social-missions.constants';
import { EnvRecord, GateFinding, GateSeverity } from './release-gate.types';

/**
 * How strictly a violation is reported. `blocking` requirements refuse the
 * release; `recommended` ones are stated and let a human decide.
 */
export type RequirementStrength = 'blocking' | 'recommended';

export interface V1FeatureRequirement {
  /** Stable machine id — used by tests and by the report. */
  readonly id: string;
  /** Human name of the product capability this flag turns on or off. */
  readonly feature: string;
  readonly envKey: string;
  /** The value an operator should set, for the actionable half of a finding. */
  readonly expected: string;
  readonly strength: RequirementStrength;
  /**
   * Whether a raw environment value satisfies the contract.
   *
   * A PREDICATE RATHER THAN AN EQUALITY, because two of these are not
   * equalities. `PAYMENTS_ENABLED` is satisfied by ANY value that is not the
   * literal `"true"` — including unset — because that is precisely how
   * `configuration.ts` resolves it (`process.env.PAYMENTS_ENABLED ===
   * 'true'`), and a contract that demanded the literal `"false"` would refuse
   * a deployment that simply never set the variable, which is both correct
   * and the commonest posture there is.
   */
  readonly satisfiedBy: (raw: string | undefined) => boolean;
  /** What shipping the wrong value actually does to the app. Never generic. */
  readonly consequence: string;
}

/** Mirrors `configuration.ts`'s fail-closed, exact-string flag convention. */
const isEnabled = (raw: string | undefined): boolean => raw === 'true';

export const V1_FEATURE_CONTRACT: readonly V1FeatureRequirement[] = [
  {
    id: 'whatsapp-login',
    feature: 'WhatsApp login',
    envKey: 'WHATSAPP_AUTH_ENABLED',
    expected: 'true',
    strength: 'blocking',
    satisfiedBy: isEnabled,
    consequence:
      'every /auth/whatsapp/* route answers 503 WHATSAPP_AUTH_DISABLED, so ' +
      'the app ships with half its login screen dead.',
  },
  {
    id: 'rewards',
    feature: 'Rewards',
    envKey: 'REWARDS_ENABLED',
    expected: 'true',
    strength: 'blocking',
    satisfiedBy: isEnabled,
    consequence:
      'every /rewards/* route answers 503 REWARDS_DISABLED, no watch credit ' +
      'is recorded, and the app ships with no earn or spend loop at all.',
  },
  {
    id: 'free-catalog',
    feature: 'Free catalog',
    envKey: 'CONTENT_ACCESS_MODE',
    expected: 'free',
    strength: 'blocking',
    satisfiedBy: (raw) => raw === 'free',
    consequence:
      'per-row access tiers are ENFORCED, and because V1 ships no purchase ' +
      'flow at all, every episode whose accessTierOverride is "premium" ' +
      'becomes listed and permanently unplayable.',
  },
  {
    id: 'payments-disabled',
    feature: 'No payments',
    envKey: 'PAYMENTS_ENABLED',
    expected: 'false',
    strength: 'blocking',
    // Unset satisfies this: `configuration.ts` resolves anything that is not
    // the literal "true" to disabled.
    satisfiedBy: (raw) => raw !== 'true',
    consequence:
      'the /payments/* routes go live and the reward catalog stops ' +
      'suppressing its VIP offers — a purchase surface V1 is specified not ' +
      'to ship, and which no store listing or support process covers.',
  },
  {
    id: 'google-login',
    feature: 'Google login',
    envKey: 'GOOGLE_AUTH_ENABLED',
    expected: 'true',
    // RECOMMENDED, NOT BLOCKING, and deliberately the one item here that is
    // not. `preflight.ts` has always warned on this rather than blocking, and
    // promoting it inside a release gate would refuse a release that the
    // preflight — the tool an operator has been running for weeks — calls
    // clean. Email/password sign-in and WhatsApp both still work without it,
    // so the app is degraded, not broken. Stated loudly, decided by a human.
    strength: 'recommended',
    satisfiedBy: isEnabled,
    consequence:
      'POST /auth/google answers 503 GOOGLE_AUTH_DISABLED. Email/password ' +
      'and WhatsApp sign-in are unaffected.',
  },
];

/**
 * The social platforms V1 requires, read from the mission catalog rather than
 * re-listed. Instagram, TikTok and YouTube carry `requiredForV1: true`;
 * Facebook deliberately does not.
 */
export const V1_REQUIRED_SOCIAL_MISSIONS: readonly SocialMissionDefinition[] =
  SOCIAL_MISSION_DEFINITIONS.filter((mission) => mission.requiredForV1);

export const V1_OPTIONAL_SOCIAL_MISSIONS: readonly SocialMissionDefinition[] =
  SOCIAL_MISSION_DEFINITIONS.filter((mission) => !mission.requiredForV1);

/**
 * Grades `env` against the contract.
 *
 * `enforcement` downgrades every BLOCKER to a WARNING in `advisory` mode.
 * That is what makes a developer able to run the gate on a laptop without
 * either faking a production posture or learning to ignore a red report —
 * and learning to ignore a red report is how a gate stops working.
 */
export function checkV1FeatureContract(
  env: EnvRecord,
  enforcement: 'blocking' | 'advisory' = 'blocking',
): GateFinding[] {
  const findings: GateFinding[] = [];

  const severityFor = (strength: RequirementStrength): GateSeverity => {
    if (strength === 'recommended') {
      return 'WARNING';
    }
    return enforcement === 'blocking' ? 'BLOCKER' : 'WARNING';
  };

  for (const requirement of V1_FEATURE_CONTRACT) {
    const raw = env[requirement.envKey];

    if (requirement.satisfiedBy(raw)) {
      findings.push({
        severity: 'PASS',
        check: `V1 contract — ${requirement.feature}`,
        detail: `${requirement.envKey}=${describe(raw)} satisfies the V1 contract.`,
      });
      continue;
    }

    findings.push({
      severity: severityFor(requirement.strength),
      check: `V1 contract — ${requirement.feature}`,
      detail: `${requirement.envKey}=${describe(raw)}, expected ${JSON.stringify(
        requirement.expected,
      )}. With the current value ${requirement.consequence}`,
    });
  }

  findings.push(...checkSocialMissionContract(env, enforcement));

  return findings;
}

/**
 * The social half of the contract: every V1-required platform must have a
 * URL that `rejectSocialUrl` accepts.
 *
 * A MISSION WITH NO URL IS NOT SERVED AT ALL — it is omitted from the rewards
 * snapshot entirely rather than rendered as a dead tile — so this is the only
 * signal anywhere that a V1 earn path is missing. Nothing 503s, nothing logs,
 * and the Rewards Center simply has fewer tiles than the product specifies.
 *
 * A value that is SET BUT MALFORMED is reported here too, with its machine
 * reason, because the mission it names is equally unserved either way.
 * `env.validation.ts` additionally refuses to BOOT on such a value, so a
 * running process can never be in this state — but a candidate configuration
 * being graded before deployment certainly can.
 */
function checkSocialMissionContract(
  env: EnvRecord,
  enforcement: 'blocking' | 'advisory',
): GateFinding[] {
  const findings: GateFinding[] = [];
  const severity: GateSeverity =
    enforcement === 'blocking' ? 'BLOCKER' : 'WARNING';

  for (const mission of V1_REQUIRED_SOCIAL_MISSIONS) {
    const raw = env[mission.envKey];
    const rejection = rejectSocialUrl(raw, mission);

    if (rejection === null) {
      findings.push({
        severity: 'PASS',
        check: `V1 contract — ${mission.platform} mission`,
        detail:
          `${mission.envKey} is a usable ${mission.platform} profile URL. ` +
          'STRUCTURAL ONLY: nothing here can confirm the account is one Red ' +
          'Panda owns.',
      });
      continue;
    }

    findings.push({
      severity,
      check: `V1 contract — ${mission.platform} mission`,
      detail:
        `${mission.envKey} is ${
          raw === undefined || raw.trim().length === 0 ? 'not set' : rejection
        }, so the ${mission.platform} mission is omitted from the Rewards ` +
        'Center entirely. V1 specifies this platform as part of the earn ' +
        `loop. Set it to a real Red Panda profile URL on ${mission.allowedHosts[0]}.`,
    });
  }

  // Stated as a PASS rather than left silent: an operator reading a report
  // that names three platforms should be able to tell that the fourth was
  // considered and is genuinely optional, not overlooked.
  const optionalConfigured = V1_OPTIONAL_SOCIAL_MISSIONS.filter(
    (mission) => rejectSocialUrl(env[mission.envKey], mission) === null,
  );

  findings.push({
    severity: 'PASS',
    check: 'V1 contract — optional social missions',
    detail:
      `${V1_OPTIONAL_SOCIAL_MISSIONS.map((m) => m.platform).join(', ')} ` +
      `${V1_OPTIONAL_SOCIAL_MISSIONS.length === 1 ? 'is' : 'are'} NOT ` +
      `required for V1 (${optionalConfigured.length} configured). A release ` +
      'is never held up for a platform the product did not ask for.',
  });

  return findings;
}

/** Renders a flag value for a report. These are all public flags, never secrets. */
function describe(raw: string | undefined): string {
  return raw === undefined ? '(unset)' : JSON.stringify(raw);
}
