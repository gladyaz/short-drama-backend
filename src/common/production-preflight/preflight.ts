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
 * not boot, or it will boot and be wrong". Everything an operator might
 * legitimately choose — no object storage, no Google sign-in — is a
 * WARNING, never a blocker.
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
 * Everything else here is posture: a deployment may legitimately run no
 * social missions at all, or run rewards with the flag off. Those are stated,
 * not blocked.
 */
function checkRewardsPosture(env: EnvRecord, add: AddFinding): void {
  if (env.REWARDS_ENABLED !== 'true') {
    add(
      'WARNING',
      'rewards',
      'REWARDS_ENABLED is not "true" — every /rewards/* route answers 503 ' +
        'REWARDS_DISABLED, no watch credit is recorded, and the app ships ' +
        'with no earn or spend loop at all. V1 is specified as free content ' +
        '+ ads + rewards, so confirm this is deliberate.',
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

  if (configured.length === 0) {
    add(
      'WARNING',
      'social missions',
      'REWARDS_ENABLED=true but no REWARDS_SOCIAL_*_URL is configured, so no ' +
        'social follow mission is served. The daily check-in and the watch ' +
        'milestones still work. Set the Instagram, TikTok and YouTube URLs ' +
        'to ship the full V1 earn loop.',
    );
    return;
  }

  add(
    'PASS',
    'social missions',
    `${configured.length} social mission(s) configured (${configured.join(', ')}). ` +
      'These are USER-CONFIRMED external actions — no platform verifies a ' +
      'follow, and the backend does not claim one.',
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
 * Posture, not correctness. Each of these is a legitimate choice an
 * operator may have made deliberately, so none of them blocks — but each
 * one silently changes what the shipped app can do, and a release owner
 * should see it stated rather than discover it from a 503.
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

  if (env.GOOGLE_AUTH_ENABLED === 'true') {
    add(
      'PASS',
      'Google sign-in',
      'GOOGLE_AUTH_ENABLED=true with client ids configured.',
    );
  } else {
    add(
      'WARNING',
      'Google sign-in',
      'GOOGLE_AUTH_ENABLED is not "true" — POST /auth/google answers 503 ' +
        'GOOGLE_AUTH_DISABLED. Email/password sign-in is unaffected.',
    );
  }

  if (env.WHATSAPP_AUTH_ENABLED === 'true') {
    add(
      'WARNING',
      'WhatsApp sign-in',
      'WHATSAPP_AUTH_ENABLED=true, but the only implemented OTP driver is ' +
        '"fake", which the boot contract refuses outside development/test. ' +
        'This configuration cannot start in production.',
    );
  }

  if (env.PAYMENTS_ENABLED === 'true') {
    add(
      'WARNING',
      'payments',
      'PAYMENTS_ENABLED=true. Payments are out of scope for V1 (free app, ' +
        'ads-monetised) — confirm this is deliberate.',
    );
  }

  // V1 INTEGRATION: the free-catalog policy is invisible in every other
  // signal — the API answers 200 either way and no URL changes — but it
  // decides whether 25 premium episodes are payable content or not. An
  // operator must see which posture they are shipping, stated, rather than
  // infer it from a viewer's experience after release.
  if (env.CONTENT_ACCESS_MODE === 'free') {
    add(
      'WARNING',
      'content access mode',
      'CONTENT_ACCESS_MODE=free — EVERY episode resolves free, including rows ' +
        'whose accessTierOverride is "premium". No database value is changed ' +
        'and the entitlement branch stays live, so this is reversible by ' +
        'unsetting the variable. Confirm this is the intended V1 posture.',
    );
  } else {
    add(
      'PASS',
      'content access mode',
      `CONTENT_ACCESS_MODE=${env.CONTENT_ACCESS_MODE ?? '(unset -> entitlement)'} — ` +
        'per-row access tiers are enforced.',
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
