/**
 * PRODUCTION HTTPS READINESS: a READ-ONLY verdict on a candidate production
 * configuration, before anything is deployed.
 *
 * WHERE THIS SITS. The repo already had the two ENDS of the release
 * timeline covered and nothing in the middle:
 *
 *   this file            `validateEnv`          `smoke:production`
 *   ---------            -------------          ------------------
 *   before deploy   ->   at boot           ->   after deploy
 *   judges a config      refuses to start       proves a live origin
 *   you have not         a bad process          actually serves bytes
 *   deployed yet
 *
 * The middle step is the cheap one: finding out that `PUBLIC_BASE_URL` is
 * still a LAN address costs a second here and a failed release later.
 *
 * WHAT IT MUST NEVER DO. No network connection, no database query, no Redis
 * command, no R2 request, no write of any kind — it is a pure function over
 * an environment record, so it is safe to run anywhere, repeatedly, against
 * production credentials. And it NEVER PRINTS A SECRET VALUE: findings name
 * variables, and echo only values that are public by nature (URLs, flags,
 * hostnames).
 *
 * IT DOES NOT INVENT REQUIREMENTS. The BLOCKER set is exactly "this will
 * not boot, or it will boot and be wrong", plus the small, named set of
 * RELEASE rules the V1 product contract settles (WhatsApp login, Google
 * login, Rewards, the required social missions, the free catalog) — each
 * marked as such where it is raised. Everything an operator might still
 * legitimately choose — no object storage, no HLS pipeline — is a WARNING,
 * never a blocker.
 */

// Loopback/LAN/https rejection is deliberately NOT re-implemented here: it
// reaches this report through the `boot contract` check below, which runs
// the real `validateEnv`. A second copy of those rules could disagree with
// the one the process actually enforces, which is the failure mode a
// preflight exists to prevent.
import { validateEnv } from '../../config/env.validation';
import {
  rejectSocialUrl,
  SOCIAL_MISSION_DEFINITIONS,
} from '../../rewards/social-missions.constants';

export type PreflightSeverity = 'PASS' | 'WARNING' | 'BLOCKER';

export interface PreflightFinding {
  severity: PreflightSeverity;
  /** Short stable name of the check, for scanning a report. */
  check: string;
  /** Why, in one sentence. Never contains a secret value. */
  detail: string;
}

export interface PreflightReport {
  findings: PreflightFinding[];
  blockers: number;
  warnings: number;
  /** True when nothing blocks a release. Warnings do not clear this flag but do not set it either. */
  ok: boolean;
}

export type EnvRecord = Record<string, string | undefined>;

/**
 * RFC2606/RFC6761 reserved names plus the placeholder words a template
 * leaves behind. A hostname matching any of these is documentation, not a
 * deployment — `https://api.example.com` passes every https/public rule in
 * `env.validation.ts` and resolves to nothing anyone owns.
 *
 * Matched on whole labels and suffixes, never as a loose substring, so a
 * legitimate domain that merely CONTAINS one of these words is not caught.
 */
const RESERVED_SUFFIXES = [
  '.example',
  '.invalid',
  '.test',
  '.localhost',
] as const;

const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'] as const;

const PLACEHOLDER_LABELS = [
  'changeme',
  'change-me',
  'change_me',
  'your-domain',
  'yourdomain',
  'placeholder',
  'todo',
  // Work unit "REWARDS V1 EARN AND SPEND": the shapes a social-profile
  // template leaves behind (`https://www.instagram.com/your-handle`). Safe to
  // add to the shared list rather than a social-only one — no real DNS label
  // is `your-handle`, so the hostname rules above are unaffected.
  'your-handle',
  'yourhandle',
  'your-account',
  'youraccount',
] as const;

export function isPlaceholderHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();

  if (RESERVED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return true;
  }

  if (
    RESERVED_DOMAINS.some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    )
  ) {
    return true;
  }

  // Whole-label match only: `todoapp.com` is a real domain, `todo.com` is
  // the shape a template placeholder leaves behind.
  const labels = host.split('.');
  return labels.some((label) =>
    (PLACEHOLDER_LABELS as readonly string[]).includes(label),
  );
}

/**
 * Variables that are safe locally and dangerous in production. Each one
 * either arms a destructive/opt-in code path or points the process at a
 * second database.
 */
const FORBIDDEN_IN_PRODUCTION: ReadonlyArray<{ key: string; why: string }> = [
  {
    key: 'DATABASE_URL_TEST',
    why: "it is the declaration that arms the retention job's destructive --commit path against a database",
  },
  {
    key: 'RUN_R2_SMOKE',
    why: 'it enables an opt-in test that writes and deletes real objects',
  },
  {
    key: 'RUN_R2_MEDIA_SMOKE',
    why: 'it enables an opt-in test that writes and deletes real objects',
  },
  {
    key: 'RUN_R2_HLS_SMOKE',
    why: 'it enables an opt-in test that writes and deletes real objects',
  },
  {
    key: 'SERIES_COVER_ORPHAN_APPLY_BUCKET',
    why: 'it arms the cover-orphan cleanup to actually delete objects',
  },
];

/** The minimum length below which a generated secret is probably a typed placeholder. */
const MIN_SECRET_LENGTH = 32;

const SECRET_KEYS = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'AUTH_AUDIT_IP_HASH_SECRET',
] as const;

/** Public URL variables, and the flag (if any) that makes each one live. */
const PUBLIC_URL_KEYS: ReadonlyArray<{
  key: string;
  isActive: (env: EnvRecord) => boolean;
}> = [
  { key: 'PUBLIC_BASE_URL', isActive: () => true },
  {
    key: 'OBJECT_STORAGE_ENDPOINT',
    isActive: (env) => env.STORAGE_DRIVER === 'r2',
  },
  {
    key: 'HLS_GATEWAY_BASE_URL',
    isActive: (env) => env.TRANSCODE_ENABLED === 'true',
  },
  {
    key: 'OBJECT_STORAGE_PUBLIC_BASE_URL',
    isActive: (env) => Boolean(env.OBJECT_STORAGE_PUBLIC_BASE_URL),
  },
];

export function runProductionPreflight(env: EnvRecord): PreflightReport {
  const findings: PreflightFinding[] = [];
  const add = (
    severity: PreflightSeverity,
    check: string,
    detail: string,
  ): void => {
    findings.push({ severity, check, detail });
  };

  checkNodeEnv(env, add);
  checkBootContract(env, add);
  checkPlaceholderUrls(env, add);
  checkProxyTopology(env, add);
  checkSecretStrength(env, add);
  checkForbiddenVariables(env, add);
  checkRewardsPosture(env, add);
  checkFeaturePosture(env, add);

  const blockers = findings.filter((f) => f.severity === 'BLOCKER').length;
  const warnings = findings.filter((f) => f.severity === 'WARNING').length;

  return { findings, blockers, warnings, ok: blockers === 0 };
}

type AddFinding = (
  severity: PreflightSeverity,
  check: string,
  detail: string,
) => void;

/**
 * FIRST, because it decides whether any other production rule applies at
 * all. `validateProductionPublicUrls`, `validateDevToolsNodeEnv` and
 * `validatePaymentsConfig` all key on the exact string `production`, so a
 * deployment that forgets this variable silently loses every one of them —
 * it would boot happily with dev tools enabled and a cleartext base URL.
 */
function checkNodeEnv(env: EnvRecord, add: AddFinding): void {
  if (env.NODE_ENV === 'production') {
    add('PASS', 'NODE_ENV', 'NODE_ENV=production');
    return;
  }

  add(
    'BLOCKER',
    'NODE_ENV',
    `NODE_ENV is ${JSON.stringify(env.NODE_ENV ?? null)}, not "production". ` +
      'Every production guard in env.validation.ts keys on that exact string, ' +
      'so this configuration would boot with the dev-tools allowlist, the ' +
      'Midtrans production guard and every public-https URL rule all disabled.',
  );
}

/**
 * The boot contract itself, reused rather than re-implemented: whatever
 * `validateEnv` refuses to start is a BLOCKER here, by construction, so the
 * preflight can never drift from what the process actually enforces.
 */
function checkBootContract(env: EnvRecord, add: AddFinding): void {
  try {
    validateEnv({ ...env });
    add(
      'PASS',
      'boot contract',
      'env.validation.ts accepts this configuration — the process would start.',
    );
  } catch (error) {
    add(
      'BLOCKER',
      'boot contract',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * `env.validation.ts` cannot catch this one: `https://api.example.com` is a
 * perfectly well-formed public https origin. It is also documentation.
 */
function checkPlaceholderUrls(env: EnvRecord, add: AddFinding): void {
  let checked = 0;
  let placeholders = 0;

  for (const { key, isActive } of PUBLIC_URL_KEYS) {
    const raw = env[key];
    if (!raw || !isActive(env)) {
      continue;
    }

    let hostname: string;
    try {
      hostname = new URL(raw).hostname;
    } catch {
      continue; // malformed values are already a BLOCKER via the boot contract.
    }

    checked += 1;

    if (isPlaceholderHostname(hostname)) {
      placeholders += 1;
      add(
        'BLOCKER',
        `${key} placeholder`,
        `${key}=${raw} still points at a reserved/placeholder domain. It is a ` +
          'valid https URL, so nothing else rejects it — and it resolves to ' +
          'nothing anyone owns.',
      );
    }
  }

  // Only claim a clean bill of health when there is one to claim: a PASS
  // printed beside a BLOCKER for the same subject is how a report loses an
  // operator's trust.
  if (checked > 0 && placeholders === 0) {
    add(
      'PASS',
      'public URL hostnames',
      `${checked} active public URL variable(s) point at real hostnames.`,
    );
  }
}

/**
 * A public https origin means TLS is terminated somewhere in front of this
 * process, because this process only ever speaks plain HTTP
 * (`app.listen(port, '0.0.0.0')` — there is no TLS server anywhere in the
 * codebase). So `TRUST_PROXY_HOPS=0` alongside an https `PUBLIC_BASE_URL`
 * is a contradiction: it says "nothing is in front of me" while the URL
 * says something is.
 *
 * A WARNING and not a BLOCKER, deliberately. The wrong direction to fail is
 * the other one — a non-zero value that is TOO HIGH lets a client forge its
 * own `X-Forwarded-For` identity, which is a security hole, whereas 0
 * behind a proxy is an availability problem the operator sees immediately
 * (every caller shares one rate-limit bucket). The right number depends on
 * a topology this code cannot see, so it is reported, not guessed.
 */
function checkProxyTopology(env: EnvRecord, add: AddFinding): void {
  const hops = env.TRUST_PROXY_HOPS?.trim();
  const publicBaseUrl = env.PUBLIC_BASE_URL ?? '';
  const isHttps = publicBaseUrl.toLowerCase().startsWith('https://');

  if (!isHttps) {
    return; // not a public-https deployment; nothing to infer.
  }

  if (hops && Number(hops) > 0) {
    add(
      'PASS',
      'TRUST_PROXY_HOPS',
      `TRUST_PROXY_HOPS=${hops} — request.ip will be the real client address.`,
    );
    return;
  }

  add(
    'WARNING',
    'TRUST_PROXY_HOPS',
    'PUBLIC_BASE_URL is https but TRUST_PROXY_HOPS is 0 (the default). This ' +
      'process serves plain HTTP, so something terminates TLS in front of it — ' +
      'and at 0, request.ip is that proxy for every caller, collapsing the ' +
      '5-logins-per-minute limit onto the entire user base and hashing one ' +
      'address into every Session/AuthAuditEvent row. Set it to the real ' +
      'number of proxies (1 on a typical managed platform). Never use true.',
  );
}

/**
 * Length only. The VALUE is never read into a finding, never logged, and
 * never compared against anything but its own length — this check exists to
 * catch `JWT_ACCESS_SECRET=secret`, not to grade entropy.
 */
function checkSecretStrength(env: EnvRecord, add: AddFinding): void {
  const weak = SECRET_KEYS.filter((key) => {
    const value = env[key];
    return typeof value === 'string' && value.length < MIN_SECRET_LENGTH;
  });

  if (weak.length === 0) {
    add(
      'PASS',
      'secret length',
      `All ${SECRET_KEYS.length} auth secrets are at least ${MIN_SECRET_LENGTH} characters.`,
    );
    return;
  }

  add(
    'WARNING',
    'secret length',
    `${weak.join(', ')} shorter than ${MIN_SECRET_LENGTH} characters. ` +
      'Generate with: openssl rand -base64 48. (Values are never printed.)',
  );
}

function checkForbiddenVariables(env: EnvRecord, add: AddFinding): void {
  const present = FORBIDDEN_IN_PRODUCTION.filter(({ key }) =>
    Boolean(env[key]),
  );

  if (present.length === 0) {
    add(
      'PASS',
      'development-only variables',
      'No development/test-only variable is set.',
    );
    return;
  }

  for (const { key, why } of present) {
    add(
      'BLOCKER',
      `${key} must not be set`,
      `${key} is set. In production ${why}.`,
    );
  }
}

/**
 * Work unit "REWARDS V1 EARN AND SPEND": whether the rewards economy this
 * release ships is the one the operator thinks it is.
 *
 * THE PLACEHOLDER CHECK IS THE BLOCKER, and it is here rather than in
 * `env.validation.ts` for the same reason the `PUBLIC_BASE_URL` placeholder
 * rule is: `https://www.instagram.com/your-handle` passes every shape rule
 * there is. It is a valid https URL on the right host with a non-empty
 * profile path. It is also a template someone forgot to fill in, and
 * shipping it sends every user who taps the tile to a profile Red Panda does
 * not own — while still paying them the points.
 *
 * REWARDS ARE REQUIRED V1, so the flag being off and the V1 platforms being
 * unconfigured both BLOCK. On `feat/v1-rewards-social` these were warnings,
 * for the same reason the WhatsApp check warned: a feature branch cannot
 * decide on its own whether a release without it is still the release. THE
 * V1 INTEGRATION DECIDES IT — the product is free content + ads + REWARDS —
 * and a preflight that answered "no blockers" for a build with no earn loop
 * would be certifying a V1 that is not V1.
 *
 * WHICH PLATFORMS COUNT IS READ FROM THE CATALOG (`requiredForV1`), never
 * re-listed here. Instagram, TikTok and YouTube are the three V1 specifies;
 * FACEBOOK IS DELIBERATELY NOT REQUIRED — its tile exists only because the
 * foundation slice already served it, and a release is not broken for
 * omitting a platform the product never asked for.
 *
 * STILL NOT BLOCKED: everything about whether the accounts are any good. This
 * check cannot see whether the profile has followers, whether the handle is
 * the brand's, or whether the link resolves — only that it is present,
 * well-shaped, and not a leftover template.
 */
function checkRewardsPosture(env: EnvRecord, add: AddFinding): void {
  if (env.REWARDS_ENABLED !== 'true') {
    add(
      'BLOCKER',
      'rewards',
      'REWARDS_ENABLED is not "true" — every /rewards/* route answers 503 ' +
        'REWARDS_DISABLED, no watch credit is recorded, and the app ships ' +
        'with no earn or spend loop at all. Red Panda V1 is specified as ' +
        'free content + ads + REWARDS, so this is not a shippable V1 ' +
        'posture.',
    );
    return;
  }

  const configured: string[] = [];

  for (const mission of SOCIAL_MISSION_DEFINITIONS) {
    const raw = env[mission.envKey];

    if (!raw || raw.trim().length === 0) {
      continue;
    }

    // A malformed value is already a BLOCKER via the boot contract; this
    // check is only interested in values that BOOT and are still wrong.
    if (rejectSocialUrl(raw, mission) !== null) {
      continue;
    }

    configured.push(mission.platform);

    const placeholder = firstPlaceholderSegment(raw);

    if (placeholder !== null) {
      add(
        'BLOCKER',
        `${mission.envKey} placeholder`,
        `${mission.envKey}=${raw} still contains the template segment ` +
          `"${placeholder}". It is a valid https URL on the right platform, ` +
          'so nothing else rejects it — and it sends every user who taps the ' +
          'tile to an account Red Panda does not own, while paying them for ' +
          'the visit.',
      );
    }
  }

  // Read from the catalog, so adding a V1 platform cannot leave this check
  // silently grading the old list. A URL that is SET but malformed is not in
  // `configured` and is therefore reported missing here too — correctly: the
  // mission it names is not served either way, and the boot-contract blocker
  // above already names the malformed value itself.
  const missingRequired = SOCIAL_MISSION_DEFINITIONS.filter(
    (mission) =>
      mission.requiredForV1 && !configured.includes(mission.platform),
  );

  if (missingRequired.length > 0) {
    add(
      'BLOCKER',
      'social missions',
      `REWARDS_ENABLED=true but ${missingRequired.length} of the V1 social ` +
        'missions has no usable profile URL: ' +
        `${missingRequired.map((mission) => mission.envKey).join(', ')}. ` +
        'A mission with no URL is not served at all, so this ships a Rewards ' +
        'Center missing part of the V1 earn loop — silently, with no error ' +
        'anywhere for anyone to notice. The daily check-in and the watch ' +
        'milestones are unaffected. REWARDS_SOCIAL_FACEBOOK_URL is NOT ' +
        'required and is not counted here.',
    );
    return;
  }

  add(
    'PASS',
    'social missions',
    `${configured.length} social mission(s) configured (${configured.join(', ')}), ` +
      'including every platform V1 requires. These are USER-CONFIRMED ' +
      'external actions — no platform verifies a follow, and the backend ' +
      'does not claim one. STRUCTURAL ONLY: this cannot confirm that a URL ' +
      'points at an account Red Panda actually owns.',
  );
}

/**
 * The first path segment of `raw` that looks like a template placeholder, or
 * `null`.
 *
 * Reuses `PLACEHOLDER_LABELS`, matched on WHOLE SEGMENTS only — `@todolist`
 * is a plausible account name, `@todo` is what a half-filled template leaves
 * behind. A leading `@` is stripped first because that is how three of the
 * four platforms write a handle.
 */
function firstPlaceholderSegment(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  for (const segment of parsed.pathname.split('/')) {
    const label = segment.replace(/^@/, '').toLowerCase();

    if ((PLACEHOLDER_LABELS as readonly string[]).includes(label)) {
      return segment;
    }
  }

  return null;
}

/**
 * Posture: the flags that silently change what the shipped app can do, and
 * which a release owner should see stated rather than discover from a 503.
 *
 * MOST OF THESE ARE A CHOICE AND SO ONLY WARN — object storage, the HLS
 * pipeline. THE V1 PRODUCT CONTRACT REMOVES THE CHOICE FROM FOUR OF THEM:
 * Google login, WhatsApp login, Rewards (in `checkRewardsPosture`) and the
 * free catalog are what V1 IS, so those block. Each says so in its own
 * finding, and each is a RELEASE rule rather than a boot rule — `validateEnv`
 * still starts a process with any of them switched off, which is what keeps
 * development and test running with no external credentials at all.
 */
function checkFeaturePosture(env: EnvRecord, add: AddFinding): void {
  if (env.STORAGE_DRIVER === 'r2') {
    add(
      'PASS',
      'storage driver',
      'STORAGE_DRIVER=r2 — media is served from object storage.',
    );
  } else {
    add(
      'WARNING',
      'storage driver',
      `STORAGE_DRIVER=${env.STORAGE_DRIVER ?? '(unset -> local)'}. Rows without an ` +
        'objectStorageKey are streamed off STORAGE_ROOT by this process, which on a ' +
        'container is an empty, ephemeral directory — those episodes will not play.',
    );
  }

  addGoogleFindings(env, add);
  addWhatsAppFindings(env, add);

  if (env.PAYMENTS_ENABLED === 'true') {
    add(
      'WARNING',
      'payments',
      'PAYMENTS_ENABLED=true. Payments are out of scope for V1 (free app, ' +
        'ads-monetised) — confirm this is deliberate.',
    );
  }

  // V1 INTEGRATION: the free-catalog policy is invisible in every other
  // signal — the API answers 200 either way, no URL changes, and no route
  // 503s — while deciding whether the premium half of the catalog is
  // reachable at all.
  //
  // THE POLARITY WAS BACKWARDS AND IS NOW CORRECTED. Until this change a
  // release with `CONTENT_ACCESS_MODE=free` WARNED ("confirm this is
  // intended") and one with `entitlement` — including the unset default, and
  // including the value the shipped `.env.production.example` carried —
  // PASSED. That grades the V1 posture as the questionable one and the
  // release-breaking posture as clean, which is precisely backwards for this
  // product:
  //
  //   V1 SHIPS NO PURCHASE FLOW OF ANY KIND. `PAYMENTS_ENABLED=false`, every
  //   /payments/* route answers 503, and the reward catalog's VIP offers are
  //   suppressed in free mode. So in `entitlement` mode an episode whose
  //   `accessTierOverride` is "premium" is not "behind a paywall" — it is
  //   permanently unreachable by any action available to any user, and the
  //   catalog currently carries such rows. The app would ship with content a
  //   viewer can see listed and can never play, and every other signal in
  //   this report would be green.
  //
  // This is the same standing the WhatsApp and Rewards checks already claim,
  // and for the same stated reason: the V1 integration decides what V1 is —
  // free content + ads + rewards + Google + WhatsApp — and a preflight that
  // answered "no blockers" for a build whose catalog is half-locked would be
  // certifying a V1 that is not V1. A deployment that genuinely wants per-row
  // enforcement is a deployment that is not this release.
  //
  // NOTHING WAS WEAKENED to get here: a posture that used to warn now
  // passes, and a posture that used to pass now blocks. The mode itself is
  // still purely a runtime policy — no database value is written by either
  // setting, and switching back is a variable change with no migration.
  if (env.CONTENT_ACCESS_MODE === 'free') {
    add(
      'PASS',
      'content access mode',
      'CONTENT_ACCESS_MODE=free — every published episode resolves free, ' +
        'including rows whose accessTierOverride is "premium". No database ' +
        'value is changed and the entitlement branch stays live, so this is ' +
        'reversible by changing the variable alone. This is the V1 posture.',
    );
  } else {
    add(
      'BLOCKER',
      'content access mode',
      `CONTENT_ACCESS_MODE=${env.CONTENT_ACCESS_MODE ?? '(unset -> entitlement)'} — ` +
        'per-row access tiers would be ENFORCED, so every episode whose ' +
        'accessTierOverride is "premium" requires an entitlement to play. ' +
        'Red Panda V1 ships no purchase flow (PAYMENTS_ENABLED=false, every ' +
        '/payments/* route answers 503) and its reward catalog suppresses the ' +
        'VIP offers in free mode, so nothing in the shipped app can ever grant ' +
        'one: those episodes would be listed and permanently unplayable, with ' +
        'no error anywhere for anyone to notice. Set CONTENT_ACCESS_MODE=free, ' +
        'or ship a release that is not V1.',
    );
  }

  // V1 INTEGRATION: reported so an enabled pipeline is never a surprise, and
  // never wrongly flagged. TRANSCODE_ENABLED=false is a perfectly valid V1
  // posture (HLS-ready rows simply fall back to their R2 source), so the
  // flag-off case is a PASS, not a warning.
  if (env.TRANSCODE_ENABLED === 'true') {
    add(
      'WARNING',
      'HLS pipeline',
      'TRANSCODE_ENABLED=true — this API mints HLS gateway tokens and a ' +
        'separate worker process consumes the Redis queue. Confirm the ' +
        'gateway at HLS_GATEWAY_BASE_URL is actually deployed and that the ' +
        'worker is running; neither is verifiable from configuration alone.',
    );
  } else {
    add(
      'PASS',
      'HLS pipeline',
      'TRANSCODE_ENABLED is off — no Redis, no worker, and no gateway is ' +
        'required. HLS-ready rows fall back to their R2 source.',
    );
  }

  if (env.DEV_TOOLS_ENABLED === 'true') {
    // Already a BLOCKER via the boot contract; repeated here so the reason
    // is legible without decoding a validator message.
    add(
      'BLOCKER',
      'dev tools',
      'DEV_TOOLS_ENABLED=true exposes /dev/admin/* self-service admin-role ' +
        'grant routes. It must be false in production.',
    );
  }
}

/**
 * GOOGLE LOGIN V1 — the named `Google sign-in` verdict.
 *
 * V1 SHIPS GOOGLE LOGIN AS A REQUIRED SIGN-IN METHOD, so "not enabled" is a
 * BLOCKER, on exactly the reasoning `addWhatsAppFindings` below already
 * states for the other half of the same login screen: the product is free
 * content + ads + rewards + Google + WhatsApp, and a preflight that answered
 * "no blockers" for a build whose Google button answers 503 would be
 * certifying a V1 that is not V1.
 *
 * WHY THIS WARNED UNTIL NOW. The check predates the V1 integration, when "no
 * Google sign-in" was genuinely one of the postures an operator might
 * legitimately choose, and the file's own rule — everything optional WARNS —
 * was applied to it correctly at the time. It is not a posture Red Panda V1
 * can choose. THE MOBILE RELEASE PREFLIGHT HAS ALWAYS TREATED GOOGLE AS
 * REQUIRED, so a WARNING here let the backend certify a candidate the other
 * half of the same release refused — two tools disagreeing about one
 * artefact, which is the worst state a release check can be in. Nothing was
 * weakened to get here: a posture that used to warn now blocks, and no
 * blocker became a warning.
 *
 * A RELEASE RULE, NOT A BOOT RULE, exactly like the WhatsApp case below.
 * `validateEnv` still starts a process with `GOOGLE_AUTH_ENABLED` unset, so
 * development, test and CI keep running with no Google configuration at all
 * and no developer needs a Google Cloud project to work on this repository.
 *
 * THE SECOND FINDING IS NOT REDUNDANT WITH THE BOOT CONTRACT. `validateEnv`
 * already refuses `GOOGLE_AUTH_ENABLED=true` with an empty
 * `GOOGLE_OAUTH_CLIENT_IDS`, and that refusal surfaces here as a `boot
 * contract` blocker — but as a validator message an operator has to decode.
 * This states it against the feature it belongs to, which is the same
 * legible-per-feature reading the WhatsApp checks give of rules the boot
 * contract also enforces.
 *
 * IT CHECKS SHAPE, NEVER EXTERNAL VALIDITY, AND NEVER ECHOES A CLIENT ID.
 * Whether an id exists in a Google Cloud project, whether the consent screen
 * is published, and whether the Play App Signing SHA-1 matches are facts only
 * Google holds; this function refuses to guess at them and says so. (The ids
 * are not secrets — one ships in the mobile binary — but a count is all this
 * check has graded, and a report gets pasted into chat windows.)
 */
function addGoogleFindings(env: EnvRecord, add: AddFinding): void {
  const CHECK = 'Google sign-in';

  if (env.GOOGLE_AUTH_ENABLED !== 'true') {
    add(
      'BLOCKER',
      CHECK,
      'GOOGLE_AUTH_ENABLED is not "true" — POST /auth/google and the Google ' +
        'link route answer 503 GOOGLE_AUTH_DISABLED, so the app ships with ' +
        'the Google button on its login screen dead. Red Panda V1 ships ' +
        'Google login as a REQUIRED sign-in method alongside WhatsApp, and ' +
        'the mobile release preflight already treats it as required, so this ' +
        'is not a shippable V1 posture. Set GOOGLE_AUTH_ENABLED=true with ' +
        'GOOGLE_OAUTH_CLIENT_IDS (docs/V1_STAGING_RUNBOOK.md §1), or ship a ' +
        'release that is not V1. Email/password sign-in is unaffected either ' +
        'way, which is why this is a RELEASE rule and not a boot rule.',
    );
    return;
  }

  // Mirrors `configuration.ts`'s `parseCsvEnv` and `env.validation.ts`'s
  // `hasNonEmptyEntry`: a value of "," parses to an EMPTY allowlist, and an
  // empty allowlist is a verifier that can accept nothing.
  const clientIdCount = (env.GOOGLE_OAUTH_CLIENT_IDS ?? '')
    .split(',')
    .filter((entry) => entry.trim().length > 0).length;

  if (clientIdCount === 0) {
    add(
      'BLOCKER',
      CHECK,
      'GOOGLE_AUTH_ENABLED=true with no usable GOOGLE_OAUTH_CLIENT_IDS. The ' +
        'boot contract refuses this: the value is the exact-match `aud` ' +
        'allowlist, and a verifier built with an empty one would answer 401 ' +
        'INVALID_GOOGLE_TOKEN to every legitimate sign-in. Set it to the ' +
        'OAuth client ids from the Red Panda Google Cloud project, ' +
        'comma-separated — it MUST include the WEB client id, which is what ' +
        'Android and iOS tokens are audienced to. The ids are public; no ' +
        'client SECRET exists or is read anywhere in this codebase.',
    );
    return;
  }

  add(
    'PASS',
    CHECK,
    `READY — GOOGLE_AUTH_ENABLED=true with ${clientIdCount} client id(s) ` +
      'configured. CODE-CONFIGURED ONLY: this cannot verify that any id ' +
      'exists in a Google Cloud project, that the OAuth consent screen is ' +
      'published, or that the Android client carries the Play App Signing ' +
      'SHA-1. Prove those with one real Google sign-in against the deployed ' +
      'origin before release — a 401 INVALID_GOOGLE_TOKEN with everything ' +
      'else correct almost always means the WEB client id is missing here.',
  );
}

/**
 * WHATSAPP LOGIN V1 — the named `WhatsApp sign-in` verdict.
 *
 * V1 SHIPS WHATSAPP LOGIN AS A REQUIRED SIGN-IN METHOD, so "not enabled" is
 * a BLOCKER: a build that reaches the Play Store with `WHATSAPP_AUTH_ENABLED`
 * unset answers `503` to every OTP route, and half the login screen is dead.
 *
 * WHY THIS IS A BLOCKER AND NOT THE WARNING THE FEATURE BRANCH SHIPPED. On
 * `feat/v1-whatsapp-auth` this check could only speak for its own feature; it
 * had no standing to decide whether a release without WhatsApp was a release,
 * so it stated the posture and let a human judge. THE V1 INTEGRATION DECIDES
 * IT: the product is free content + ads + rewards + Google + WhatsApp, and a
 * preflight that answered "no blockers" for a build with no WhatsApp
 * transport would be certifying a V1 that is not V1. Nothing was weakened to
 * get here — a posture that used to warn now blocks.
 *
 * A BLOCKER otherwise means "this will not boot, or it will boot and be
 * wrong" — the same bar the rest of this file uses. Every OTHER blocker below
 * is a posture `validateEnv` also refuses, which is deliberate: the boot
 * contract is the enforcement, and this is the legible, per-feature reading
 * of it an operator gets BEFORE spending a deploy to find out. The
 * feature-absent blocker is the one exception, and it is a RELEASE rule
 * rather than a boot rule on purpose: development and test must keep starting
 * with no Meta credentials at all.
 *
 * IT CHECKS PRESENCE, NEVER VALIDITY, and never echoes a value. Whether a
 * token is accepted by Meta, whether the template is approved, and whether
 * the number can send are all facts only Meta holds; this function refuses
 * to guess at them and says so, rather than reporting a green light it
 * cannot actually see.
 */
function addWhatsAppFindings(
  env: EnvRecord,
  add: (severity: PreflightSeverity, check: string, detail: string) => void,
): void {
  const CHECK = 'WhatsApp sign-in';

  if (env.WHATSAPP_AUTH_ENABLED !== 'true') {
    add(
      'BLOCKER',
      CHECK,
      'WHATSAPP_AUTH_ENABLED is not "true" — every /auth/whatsapp/* route ' +
        'answers 503 WHATSAPP_AUTH_DISABLED, so the app ships with half its ' +
        'login screen dead. Red Panda V1 ships WhatsApp login as a REQUIRED ' +
        'sign-in method alongside Google, so this is not a shippable V1 ' +
        'posture. Set WHATSAPP_AUTH_ENABLED=true with ' +
        'WHATSAPP_OTP_PROVIDER_DRIVER=cloud-api and the Cloud API sender ' +
        'variables (docs/WHATSAPP_LOGIN_SETUP.md), or ship a release that is ' +
        'not V1.',
    );
    return;
  }

  const driver = env.WHATSAPP_OTP_PROVIDER_DRIVER?.trim() ?? '';

  if (driver.length === 0) {
    add(
      'BLOCKER',
      CHECK,
      'WHATSAPP_AUTH_ENABLED=true with no WHATSAPP_OTP_PROVIDER_DRIVER. The ' +
        'boot contract refuses this: there is no default driver, because a ' +
        'backend that accepts OTP requests without a delivery provider would ' +
        'answer 202 while sending nothing.',
    );
    return;
  }

  if (driver === 'fake') {
    add(
      'BLOCKER',
      CHECK,
      'WHATSAPP_OTP_PROVIDER_DRIVER=fake delivers NO message and retains ' +
        'plaintext codes in memory. The boot contract refuses it outside ' +
        'NODE_ENV=development/test, so this configuration cannot start in ' +
        'production. Use WHATSAPP_OTP_PROVIDER_DRIVER=cloud-api.',
    );
    return;
  }

  if (driver !== 'cloud-api') {
    add(
      'BLOCKER',
      CHECK,
      `WHATSAPP_OTP_PROVIDER_DRIVER=${driver} is not an implemented driver. ` +
        'The boot contract refuses it. The production driver is "cloud-api".',
    );
    return;
  }

  const missing = [
    'WHATSAPP_CLOUD_API_PHONE_NUMBER_ID',
    'WHATSAPP_CLOUD_API_ACCESS_TOKEN',
    'WHATSAPP_CLOUD_API_TEMPLATE_NAME',
    'WHATSAPP_CLOUD_API_TEMPLATE_LANGUAGE',
  ].filter((key) => (env[key]?.trim() ?? '').length === 0);

  if (missing.length > 0) {
    // Variable NAMES only — one of these is an access token, and a preflight
    // report is exactly the kind of output that gets pasted into a chat.
    add(
      'BLOCKER',
      CHECK,
      'WHATSAPP_OTP_PROVIDER_DRIVER=cloud-api is missing required ' +
        `configuration: ${missing.join(', ')}. The boot contract refuses an ` +
        'incomplete Cloud API sender. See docs/WHATSAPP_LOGIN_SETUP.md.',
    );
    return;
  }

  add(
    'PASS',
    CHECK,
    'READY — WHATSAPP_AUTH_ENABLED=true, driver=cloud-api, and all four ' +
      'Cloud API sender variables are set. STRUCTURAL ONLY: this cannot ' +
      'verify that the access token is valid, that the template is approved ' +
      'and un-paused, or that the sender number can reach WhatsApp. Confirm ' +
      'those in the Meta dashboard, and prove them with one real end-to-end ' +
      'OTP to a test number before release.',
  );
}
