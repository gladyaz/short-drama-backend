/**
 * RELEASE GATE MODES — the answer to "what, exactly, did a green gate just
 * prove?"
 *
 * A release check that grades one thing and is read as proving another is
 * worse than no check at all, because it is trusted. This file makes the
 * three legitimate questions separate, names them, and makes the report say
 * which one was asked:
 *
 *   LOCAL       "does my working copy hold together right now?"
 *               Config comes from the developer's ambient environment (their
 *               `.env`, via the CLI's dotenv load). Feature-policy findings
 *               are ADVISORY, because a laptop is not a release candidate and
 *               nobody should have to fake a production posture to run a
 *               build.
 *
 *   CI          "is this COMMIT structurally capable of being a V1 release?"
 *               Config comes from a SYNTHETIC, test-only fixture built in
 *               this file — never from the ambient environment, so the answer
 *               is a property of the code and cannot be changed by whatever
 *               happens to be exported on the runner. Feature policy is
 *               BLOCKING against that fixture.
 *
 *   PRODUCTION  "is THIS candidate configuration a shippable V1?"
 *               Config comes from the ambient process environment and
 *               nowhere else. Feature policy is BLOCKING.
 *
 * THE DISTINCTION THIS EXISTS TO PROTECT, restated because it is the whole
 * point: CI mode can prove a release is CODE-VALID. It can never prove it is
 * EXTERNAL-VERIFIED. A synthetic fixture that satisfies every rule proves the
 * rules accept a complete V1 shape — not that a bucket has bytes in it, that
 * a Meta template is approved, or that a hostname resolves. `docs/
 * V1_RELEASE_GATE.md` states the three-level ladder; every report printed by
 * this gate repeats it.
 */
import {
  SOCIAL_MISSION_DEFINITIONS,
  SocialMissionDefinition,
} from '../../rewards/social-missions.constants';
import { EnvRecord } from './release-gate.types';

export type ReleaseGateMode = 'local' | 'ci' | 'production';

export const RELEASE_GATE_MODES: readonly ReleaseGateMode[] = [
  'local',
  'ci',
  'production',
];

export function isReleaseGateMode(value: string): value is ReleaseGateMode {
  return (RELEASE_GATE_MODES as readonly string[]).includes(value);
}

/**
 * Where the configuration being graded came from. Printed in the report
 * header so a reader never has to guess whether the verdict describes their
 * shell or a fixture.
 */
export type ConfigSource = 'ambient-environment' | 'structural-fixture';

/** Whether a feature-policy violation blocks the release or is merely noted. */
export type PolicyEnforcement = 'blocking' | 'advisory';

export interface ReleaseModeResolution {
  mode: ReleaseGateMode;
  configSource: ConfigSource;
  /** The environment record every config-shaped check is run against. */
  env: EnvRecord;
  policyEnforcement: PolicyEnforcement;
  /** One sentence: what a clean run in this mode does and does not prove. */
  claim: string;
}

/**
 * THE SYNTHETIC HOSTNAME EVERY STRUCTURAL VALUE IS BUILT FROM.
 *
 * It has to thread a needle. It must NOT be a reserved or placeholder
 * hostname — `preflight.ts` blocks `.example`, `.invalid`, `.test`,
 * `.localhost`, `example.com` and the template words (`changeme`,
 * `your-handle`, …), so any of those would make CI mode block on its own
 * fixture and prove nothing. It must ALSO be unmistakably not a real Red
 * Panda origin, so that a value from this file can never be pasted into a
 * deployment and mistaken for one.
 *
 * A registrable-looking but deliberately absurd label satisfies both: the
 * hostname rules accept it, and no human reads it as production.
 */
const STRUCTURAL_HOST = 'release-gate-structural-fixture-not-a-real-host.app';

/**
 * The synthetic profile path used for every required social mission.
 *
 * Deliberately NOT one of `preflight.ts`'s `PLACEHOLDER_LABELS`
 * (`your-handle`, `todo`, …): the placeholder rule is one of the rules CI
 * mode is meant to exercise, so a fixture that tripped it would turn a real
 * check into noise. It is still self-describing enough that it could never be
 * mistaken for a marketing handle.
 */
const STRUCTURAL_SOCIAL_HANDLE = 'redpandastructuralfixture';

/**
 * A structural social profile URL for `mission`, on the platform's own
 * canonical host.
 *
 * THE HOST IS READ FROM THE MISSION CATALOG (`allowedHosts[0]`), never
 * re-typed here. `rejectSocialUrl` pins each platform's URL to that
 * allowlist, so a hand-written host in this file would silently stop
 * satisfying the contract the day a platform's allowlist changed — and CI
 * would start failing on its own fixture rather than on the code.
 */
export function structuralSocialUrl(mission: SocialMissionDefinition): string {
  const host = mission.allowedHosts[0];
  const handle =
    mission.platform === 'TIKTOK' || mission.platform === 'YOUTUBE'
      ? `@${STRUCTURAL_SOCIAL_HANDLE}`
      : STRUCTURAL_SOCIAL_HANDLE;

  return `https://${host}/${handle}`;
}

/**
 * A complete, structurally valid Red Panda V1 production posture made
 * entirely of synthetic, test-only values.
 *
 * EVERY SECRET-SHAPED VALUE IS A REPEATED LITERAL AND SAYS SO IN ITS OWN
 * TEXT. Nothing here is, or has ever been, a credential: the strings are
 * long enough to clear the preflight's 32-character length rule and are
 * spelled so that grepping the repository for a leaked secret can never
 * confuse one of them for a real one.
 *
 * Only the REQUIRED social missions are populated. Facebook is
 * `requiredForV1: false` in the catalog, so leaving it unset is exactly the
 * posture the contract must accept — and populating it would have hidden a
 * regression that made it mandatory.
 */
export function buildStructuralV1Env(): EnvRecord {
  const socialUrls: EnvRecord = {};

  for (const mission of SOCIAL_MISSION_DEFINITIONS) {
    if (mission.requiredForV1) {
      socialUrls[mission.envKey] = structuralSocialUrl(mission);
    }
  }

  return {
    NODE_ENV: 'production',
    PORT: '3000',
    PUBLIC_BASE_URL: `https://${STRUCTURAL_HOST}`,
    CORS_ORIGINS: '',
    TRUST_PROXY_HOPS: '1',
    DATABASE_URL: STRUCTURAL_DATABASE_URL,

    // THE FIXTURE IS THE POSTURE THE RUNBOOK'S RELEASE MATRIX SPECIFIES
    // (docs/V1_STAGING_RUNBOOK.md §2), not the weakest posture that would
    // boot. Staging and production both run `STORAGE_DRIVER=r2` with Google
    // sign-in on, so grading `local`/no-Google here would leave the R2 public
    // URL rules and the Google client-id rule UNEXERCISED in CI — and would
    // print two warnings that describe the fixture rather than the code,
    // which is how a report's warnings stop being read.
    STORAGE_DRIVER: 'r2',
    STORAGE_ROOT: process.cwd(),
    OBJECT_STORAGE_ENDPOINT: `https://storage.${STRUCTURAL_HOST}`,
    OBJECT_STORAGE_REGION: 'auto',
    OBJECT_STORAGE_BUCKET: 'release-gate-structural-fixture',
    OBJECT_STORAGE_ACCESS_KEY_ID:
      'release-gate-structural-fixture-access-key-id-not-real',
    OBJECT_STORAGE_SECRET_ACCESS_KEY:
      'release-gate-structural-fixture-secret-access-key-not-real',

    GOOGLE_AUTH_ENABLED: 'true',
    GOOGLE_OAUTH_CLIENT_IDS:
      'release-gate-structural-fixture-not-real.apps.googleusercontent.com',

    // Distinct from one another on purpose: `validateAuthSecretDistinctness`
    // refuses a configuration that reuses one secret for two roles, and a
    // fixture that shared them would never exercise that rule.
    JWT_ACCESS_SECRET: 'release-gate-structural-fixture-access-secret-not-real',
    JWT_REFRESH_SECRET:
      'release-gate-structural-fixture-refresh-secret-not-real',
    AUTH_AUDIT_IP_HASH_SECRET:
      'release-gate-structural-fixture-ip-hash-secret-not-real',

    DEV_TOOLS_ENABLED: 'false',
    PAYMENTS_ENABLED: 'false',
    CONTENT_ACCESS_MODE: 'free',
    TRANSCODE_ENABLED: 'false',

    WHATSAPP_AUTH_ENABLED: 'true',
    WHATSAPP_OTP_PROVIDER_DRIVER: 'cloud-api',
    WHATSAPP_CLOUD_API_PHONE_NUMBER_ID: '000000000000000',
    WHATSAPP_CLOUD_API_ACCESS_TOKEN:
      'release-gate-structural-fixture-whatsapp-token-not-real',
    WHATSAPP_CLOUD_API_TEMPLATE_NAME: 'release_gate_structural_fixture',
    WHATSAPP_CLOUD_API_TEMPLATE_LANGUAGE: 'id',

    REWARDS_ENABLED: 'true',
    ...socialUrls,
  };
}

/**
 * The database URL handed to `prisma validate` in structural mode.
 *
 * `prisma.config.ts` REQUIRES the variable to be present — it reads it
 * through `env('DATABASE_URL')` and throws if it is missing — but `prisma
 * validate` only parses the schema and never opens a connection. So this
 * value exists to satisfy a config loader, and its hostname is deliberately
 * `.invalid` (RFC 6761: guaranteed never to resolve) so that if any future
 * command DID try to connect, it would fail loudly instead of quietly
 * reaching something real.
 */
export const STRUCTURAL_DATABASE_URL =
  'postgresql://release_gate_structural:release_gate_structural@release-gate.invalid:5432/release_gate_structural_only';

const CLAIMS: Record<ReleaseGateMode, string> = {
  local:
    'A clean LOCAL run proves this working copy builds, lints and passes the ' +
    'code-only checks. Feature-policy findings are ADVISORY here and prove ' +
    'nothing about any deployment.',
  ci:
    'A clean CI run proves this COMMIT is CODE-VALID: the rules accept a ' +
    'structurally complete V1 posture and refuse the postures they are meant ' +
    'to refuse. It proves NOTHING about any real credential, host, bucket or ' +
    'external service.',
  production:
    'A clean PRODUCTION run proves THIS CANDIDATE CONFIGURATION is a ' +
    'structurally shippable V1. It still proves nothing about whether the ' +
    'token works, the template is approved, the bucket has bytes, or the ' +
    'hostname resolves — only a deployed-origin smoke run can say that.',
};

/**
 * Resolves the mode, and with it the exact environment record every
 * config-shaped check will grade.
 *
 * `ambient` is passed in rather than read from `process.env` so that every
 * mode is testable without mutating global state in a test running beside
 * others — the same reason `resolveSocialMissionCatalog` takes its
 * environment as an argument.
 *
 * CI MODE IGNORES `ambient` ENTIRELY. That is the load-bearing property: it
 * is what makes a CI verdict a fact about the commit rather than a fact about
 * the runner's exported variables.
 */
export function resolveReleaseGateMode(
  mode: ReleaseGateMode,
  ambient: EnvRecord,
): ReleaseModeResolution {
  if (mode === 'ci') {
    return {
      mode,
      configSource: 'structural-fixture',
      env: buildStructuralV1Env(),
      policyEnforcement: 'blocking',
      claim: CLAIMS.ci,
    };
  }

  return {
    mode,
    configSource: 'ambient-environment',
    env: { ...ambient },
    policyEnforcement: mode === 'production' ? 'blocking' : 'advisory',
    claim: CLAIMS[mode],
  };
}
