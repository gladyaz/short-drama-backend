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
 * EVERY REQUIREMENT BELOW IS BLOCKING, INCLUDING GOOGLE LOGIN. Google was the
 * single `recommended` item until the release-policy alignment that added
 * `google-client-ids`, and it was recommended only because `preflight.ts`
 * warned rather than blocked — a tool-agreement reason, not a product one.
 * The confirmed V1 contract requires GOOGLE LOGIN and WHATSAPP LOGIN alike,
 * the mobile release preflight has always treated Google as required, and a
 * backend that certified a candidate the mobile side refuses is the defect
 * this list exists to prevent. Both tools now block; `v1-feature-contract.spec.ts`
 * pins that they cannot drift apart again.
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
  /**
   * How the value appears in a finding. Defaults to the value itself, which
   * is right for every public flag here — `WHATSAPP_AUTH_ENABLED="false"` is
   * the whole point of the sentence it appears in.
   *
   * `google-client-ids` overrides it. Those ids are NOT secrets (see that
   * requirement's own note), but a release report is exactly the kind of
   * output that gets pasted into a chat window, and a COUNT answers the only
   * question this contract actually asks of them.
   */
  readonly describeValue?: (raw: string | undefined) => string;
}

/** Mirrors `configuration.ts`'s fail-closed, exact-string flag convention. */
const isEnabled = (raw: string | undefined): boolean => raw === 'true';

/**
 * Whether a comma-separated variable carries at least one non-blank entry.
 *
 * Mirrors `configuration.ts`'s `parseCsvEnv` (split, trim, drop blanks) and
 * `env.validation.ts`'s `hasNonEmptyEntry` exactly, because all three must
 * agree on what "configured" means: a value of `",,"` parses to an EMPTY
 * allowlist, and an empty allowlist is a verifier that accepts nothing.
 */
const hasNonEmptyCsvEntry = (raw: string | undefined): boolean =>
  (raw ?? '').split(',').some((entry) => entry.trim().length > 0);

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
    // BLOCKING. This was the one `recommended` item in this list, and the
    // reason it was recommended was never a product reason.
    //
    // THE OLD REASON WAS TOOL AGREEMENT: `preflight.ts` warned rather than
    // blocked, so promoting it here would have made the gate refuse a
    // candidate the preflight called clean. That hazard is real, and the fix
    // for it is to move BOTH tools — which is what this change does — not to
    // grade the product contract by whichever tool happened to be the more
    // lenient of the two.
    //
    // THE PRODUCT CONTRACT HAS ONE ANSWER. Red Panda V1 ships GOOGLE LOGIN
    // and WHATSAPP LOGIN, both REQUIRED. The MOBILE release preflight has
    // always treated Google as required, so the previous severity let the
    // backend certify a candidate that the other half of the same release
    // refused — two halves of one release disagreeing about whether it is
    // releasable, which is worse than either of them having no opinion.
    //
    // "EMAIL/PASSWORD STILL WORKS" IS TRUE AND IS NOT THE BAR — it is the
    // same sentence that was true of WhatsApp before the integration settled
    // that one. V1's login screen ships a Google button, and a build with
    // this flag off answers 503 to every tap on it: a dead control in the
    // shipped UI, with no error anywhere for a release owner to notice.
    strength: 'blocking',
    satisfiedBy: isEnabled,
    consequence:
      'POST /auth/google and the Google link route answer 503 ' +
      'GOOGLE_AUTH_DISABLED, so the app ships with the Google button on its ' +
      'login screen dead. This is a RELEASE rule, not a boot rule: ' +
      'development and test still start with no Google configuration at all.',
  },
  {
    id: 'google-client-ids',
    feature: 'Google client ids',
    envKey: 'GOOGLE_OAUTH_CLIENT_IDS',
    expected: 'at least one non-empty OAuth client id',
    // UNCONDITIONAL HERE, CONDITIONAL AT BOOT — and that difference is
    // exactly the difference between the two tools rather than a drift
    // between them. `env.validation.ts` requires this only when
    // `GOOGLE_AUTH_ENABLED=true`, because a process with Google switched off
    // has no use for an audience allowlist. A V1 RELEASE CANDIDATE has Google
    // switched on, by the requirement immediately above, so for a release the
    // condition collapses and the ids are simply required.
    //
    // WHY IT IS A SEPARATE REQUIREMENT rather than folded into the flag: the
    // two failures are different failures with different fixes. Flag off
    // ships a dead button; flag on with an empty allowlist does not boot at
    // all, and if it somehow did it would answer 401 to every legitimate
    // sign-in. A single finding could only have named one of them.
    //
    // NOT A SECRET, and worth stating rather than leaving to be inferred. A
    // Google OAuth client id ships inside the mobile app binary and is public
    // by design; the OAuth client SECRET is never read anywhere in this
    // codebase, because verifying an ID token needs only Google's public keys
    // and the client id. Even so `describeValue` reports a COUNT — a release
    // report gets pasted into chat windows, and the count is the whole of
    // what this check actually asks.
    strength: 'blocking',
    satisfiedBy: hasNonEmptyCsvEntry,
    describeValue: describeClientIds,
    consequence:
      'the process refuses to boot while GOOGLE_AUTH_ENABLED=true, and a ' +
      'verifier constructed with an empty audience allowlist can accept no ' +
      'token at all — every real sign-in would answer 401 ' +
      'INVALID_GOOGLE_TOKEN. Set it to the OAuth client ids from the Red ' +
      'Panda Google Cloud project, comma-separated; it MUST include the WEB ' +
      'client id, which is what Android and iOS tokens are audienced to.',
  },
];

/**
 * A `GOOGLE_OAUTH_CLIENT_IDS` value rendered as a COUNT, never as a value.
 *
 * Reports the number of non-blank entries, which is precisely the fact
 * `hasNonEmptyCsvEntry` graded — so a report is legible ("0 client ids"
 * versus `(unset)` versus `",,"`) without carrying the ids themselves.
 */
function describeClientIds(raw: string | undefined): string {
  if (raw === undefined) {
    return '(unset)';
  }

  const count = raw
    .split(',')
    .filter((entry) => entry.trim().length > 0).length;

  return `${count} non-empty client id(s)`;
}

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
    // `describeValue` where a requirement supplies one — see its doc comment
    // on `V1FeatureRequirement`; otherwise the value itself, which is a
    // public flag in every remaining case.
    const shown = requirement.describeValue
      ? requirement.describeValue(raw)
      : describe(raw);

    if (requirement.satisfiedBy(raw)) {
      findings.push({
        severity: 'PASS',
        check: `V1 contract — ${requirement.feature}`,
        detail: `${requirement.envKey}=${shown} satisfies the V1 contract.`,
      });
      continue;
    }

    findings.push({
      severity: severityFor(requirement.strength),
      check: `V1 contract — ${requirement.feature}`,
      detail: `${requirement.envKey}=${shown}, expected ${JSON.stringify(
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
