import { existsSync, statSync } from 'fs';
// The single source of truth for which OTP delivery drivers exist. Imported
// rather than re-listed here so that adding a driver cannot leave the boot
// contract silently disagreeing with the module factory that binds it. The
// module is a pure constants/types file with no framework imports, so this
// does not pull the auth stack into config validation.
import { WHATSAPP_OTP_DRIVERS } from '../auth/identity/whatsapp/whatsapp-otp.types';
import {
  rejectSocialUrl,
  SOCIAL_MISSION_DEFINITIONS,
  SocialUrlRejection,
} from '../rewards/social-missions.constants';
import {
  isLoopbackHostname,
  isPrivateHostname,
} from '../common/net/public-host';
import {
  CONTENT_ACCESS_MODES,
  ContentAccessMode,
  DEFAULT_CONTENT_ACCESS_MODE,
  DEFAULT_STORAGE_DRIVER,
  STORAGE_DRIVERS,
  StorageDriver,
} from './configuration';

const REQUIRED_KEYS = [
  'PORT',
  'PUBLIC_BASE_URL',
  'STORAGE_ROOT',
  // `CORS_ORIGINS` is deliberately NOT in this list — see
  // `validateCorsOrigins`. This loop rejects any FALSY value, and an empty
  // string is the correct, documented deny-all answer for a mobile-only
  // deployment, so requiring it here made the shipped
  // `.env.production.example` (which sets `CORS_ORIGINS=`) unbootable.
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  // Phase 12, work unit 12A-B3: dedicated HMAC key for `AuthAuditEvent.ipHash`
  // (DECISIONS.md "Phase 12 ... approved..." entry, decision 6) — required
  // unconditionally (not gated behind a feature flag) since `AuthAuditService`
  // is wired into the core login/register/refresh paths, not an optional
  // add-on.
  'AUTH_AUDIT_IP_HASH_SECRET',
] as const;

/**
 * Phase 11, work unit 11G-3: `OBJECT_STORAGE_*` env var NAMES required only
 * when `STORAGE_DRIVER=r2` — these are exactly the five fields
 * `StorageService`/`StorageModule` need to construct an `S3Client` and issue
 * every command they make: `endpoint`/`region`/`accessKeyId`/
 * `secretAccessKey` (the `S3Client` constructed in `storage.module.ts`) and
 * `bucket` (every S3 command in `storage.service.ts`). This is
 * presence/name validation only — no value is ever read into an error
 * message and no network call is made here.
 *
 * Phase 11, work unit 11H-B1 update: `OBJECT_STORAGE_PUBLIC_BASE_URL` is
 * DELIBERATELY NOT in this list (it used to be — this list was six names
 * before 11H-B1). It is read only by `StorageService.buildPublicUrl`, which
 * has ZERO callers in production code (only its own spec exercises it) and
 * is never touched by `createPresignedPutUrl`/`createPresignedGetUrl`/
 * `headObject`/`objectExists`/`deleteObject`/`putObject`. The dev R2 bucket
 * is private, `r2.dev` is disabled, and no custom domain exists, so private
 * upload/playback uses presigned PUT/GET exclusively — requiring a public
 * base URL at boot blocked a correctly-configured private bucket from ever
 * starting, for a value it has no use for. `buildPublicUrl` still fails
 * loudly (naming this exact variable, never a value) if it is ever called
 * without one configured — see its doc comment in `storage.service.ts`.
 *
 * Exported (Phase 11, work unit 11G-4) so `StorageReadinessService` and the
 * opt-in disposable-object smoke test can reuse the exact same list of
 * variable NAMES instead of duplicating it — neither ever reads this
 * constant as anything but a list of names to check presence/env-var access
 * for.
 */
export const REQUIRED_R2_KEYS = [
  'OBJECT_STORAGE_ENDPOINT',
  'OBJECT_STORAGE_REGION',
  'OBJECT_STORAGE_BUCKET',
  'OBJECT_STORAGE_ACCESS_KEY_ID',
  'OBJECT_STORAGE_SECRET_ACCESS_KEY',
] as const;

export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of REQUIRED_KEYS) {
    if (!config[key]) {
      throw new Error(
        `Missing required environment variable: ${key}. Copy .env.example to .env and fill in real values.`,
      );
    }
  }

  const storageRoot = String(config.STORAGE_ROOT);

  if (!existsSync(storageRoot) || !statSync(storageRoot).isDirectory()) {
    throw new Error(
      `STORAGE_ROOT does not exist or is not a directory: "${storageRoot}". ` +
        'Set STORAGE_ROOT in .env to a valid company video storage path.',
    );
  }

  validateAuthSecretDistinctness(config);

  validateStorageDriver(config);

  validateCorsOrigins(config);

  validateTrustProxyHops(config);

  validateDevToolsNodeEnv(config);

  validateTranscodeConfig(config);

  validateHlsGatewayConfig(config);

  validatePaymentsConfig(config);

  validateIdentityProvidersConfig(config);

  validateRewardsConfig(config);

  validateContentAccessMode(config);

  // DELIBERATELY LAST. This check fires only under NODE_ENV=production, which
  // is exactly the condition several guards above also key on
  // (`validateDevToolsNodeEnv`, `validatePaymentsConfig`). Running it earlier
  // made it PREEMPT them: a config with both DEV_TOOLS_ENABLED=true and an
  // http base URL reported the base URL and hid the privilege-escalation
  // problem. A security guard must always be the error an operator sees first.
  //
  // INTEGRATION NOTE: `validateContentAccessMode` (the V1 free-catalog policy)
  // is deliberately placed ABOVE this block rather than below it. It is an
  // unconditional, environment-independent shape check like every other
  // validator in the group above, so it belongs with them — and putting it
  // after this block would have made a malformed CONTENT_ACCESS_MODE hide a
  // cleartext production URL, re-opening exactly the preemption problem this
  // comment records.
  validateProductionPublicUrls(config);

  return config;
}

/**
 * The three unconditionally-required auth secrets must all be DIFFERENT
 * from each other.
 *
 * WHY THIS WAS MISSING AND WHY IT MATTERS. `.env.production.example` has
 * always told the operator "Must be different from JWT_ACCESS_SECRET", and
 * `validateHlsGatewayConfig` already enforces exactly this rule for
 * `HLS_TOKEN_SECRET` against all three — but nothing enforced it *among*
 * the three themselves, so the documented requirement was honor-system
 * only. A single generated value pasted into all three lines boots cleanly
 * today.
 *
 * The consequence is blast radius, not immediate token confusion: refresh
 * tokens here are opaque random bytes (`randomBytes`), not JWTs, and
 * `jwtRefreshSecret` is used as an HMAC key to hash them at rest — as it
 * also is for password-reset tokens (`auth.constants.ts`) and the WhatsApp
 * OTP hash (`whatsapp-otp.service.ts`). So an access token cannot be
 * replayed as a refresh token. What collapses is separation: one leaked
 * value would let an attacker forge access tokens AND compute the stored
 * hash of any refresh/reset/OTP token AND correlate every `ipHash` — and
 * rotating it to close one of those would sign out every session and break
 * every audit correlation at the same time. That separation is the exact
 * rationale `AuthConfig.authAuditIpHashSecret` records for existing as its
 * own variable, so leaving it unenforced contradicted the design.
 *
 * NEVER LOGS A VALUE — only ever names the two variables that collided,
 * matching `validateHlsGatewayConfig`'s established message shape.
 */
const DISTINCT_AUTH_SECRET_KEYS = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'AUTH_AUDIT_IP_HASH_SECRET',
] as const;

function validateAuthSecretDistinctness(config: Record<string, unknown>): void {
  for (let i = 0; i < DISTINCT_AUTH_SECRET_KEYS.length; i += 1) {
    for (let j = i + 1; j < DISTINCT_AUTH_SECRET_KEYS.length; j += 1) {
      const firstKey = DISTINCT_AUTH_SECRET_KEYS[i];
      const secondKey = DISTINCT_AUTH_SECRET_KEYS[j];

      // Read into separate locals BEFORE any truthiness narrowing, for the
      // same `no-base-to-string` reason `validateTranscodeConfig` documents.
      const first = config[firstKey];
      const second = config[secondKey];

      if (typeof first !== 'string' || typeof second !== 'string') {
        continue; // absence is already reported by REQUIRED_KEYS above.
      }

      if (first === second) {
        throw new Error(
          `Invalid ${secondKey}: must be DISTINCT from ${firstKey}. ` +
            'Generate each secret independently (openssl rand -base64 48). ' +
            'Sharing one value means a single leak forges access tokens, ' +
            'computes the stored hash of every refresh/reset/OTP token, and ' +
            'de-anonymises every ipHash at once — and rotating it to fix any ' +
            'one of those breaks the other two. Values are never logged — ' +
            'only variable names are compared.',
        );
      }
    }
  }
}

/**
 * Work unit "REWARDS BACKEND FOUNDATION". `REWARDS_ENABLED` needs no
 * validation of its own — like every other feature flag in this file it is
 * "the literal string `true` or it is off", which cannot be malformed.
 *
 * `REWARDS_TIMEZONE` is OPTIONAL (it has a documented default,
 * `DEFAULT_REWARDS_TIMEZONE`), mirroring the `TRANSCODE_MAX_ATTEMPTS` /
 * `HLS_TOKEN_TTL_SECONDS` "optional, but must be well-formed if present"
 * pattern. What it must not be is a value `Intl` cannot resolve.
 *
 * WHY THIS IS CHECKED AT BOOT AND NOT AT FIRST USE. `Intl.DateTimeFormat`
 * throws `RangeError` for an unknown zone, and the ONLY places that
 * construct one are on the check-in and snapshot paths. Without this gate a
 * typo like `Asia/Jakata` would start the process cleanly and then fail
 * every rewards request at runtime with an opaque 500 — the daily boundary
 * that the entire anti-farming design rests on would be broken, and the
 * first symptom would be user-facing. Failing the boot instead makes a
 * misconfiguration impossible to deploy unnoticed.
 *
 * VALIDATED UNCONDITIONALLY, not only when `REWARDS_ENABLED=true`: a
 * deployment that sets a broken timezone while the feature is dark should
 * find out when it sets it, not weeks later when someone flips the flag.
 */
function validateRewardsConfig(config: Record<string, unknown>): void {
  // FIRST, and deliberately before the timezone block below, which RETURNS
  // EARLY when `REWARDS_TIMEZONE` is unset (an unset optional variable is not
  // a misconfiguration). Calling the social check after that return would
  // have silently skipped it for every deployment using the default
  // timezone — which is most of them.
  validateRewardsSocialUrls(config);

  // Narrowed to `string` explicitly rather than coerced with `String()`.
  // Config values are always strings in practice; a non-string here is an
  // unexpected shape, not something to stringify — the same discipline
  // `assertPositiveIntEnvIfPresent` above uses, and it sidesteps the
  // `no-base-to-string` trap that the `rawRedisUrl` comment documents.
  const raw = config.REWARDS_TIMEZONE;

  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return;
  }

  const timezone = raw.trim();

  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
  } catch {
    throw new Error(
      `REWARDS_TIMEZONE is not a valid IANA timezone: "${timezone}". ` +
        'Use a zone name such as "Asia/Jakarta", or unset it to use the default.',
    );
  }
}

/**
 * Work unit "REWARDS V1 EARN AND SPEND": the four `REWARDS_SOCIAL_*_URL`
 * variables, each OPTIONAL but strictly shaped if present.
 *
 * WHY AN UNSET VARIABLE IS FINE AND A MALFORMED ONE IS FATAL. Unset means "we
 * do not run that mission", which is a legitimate posture and is how the
 * feature rolls out one platform at a time. A value that is SET but unusable
 * is a different thing entirely: an operator has decided to run the mission
 * and typed something wrong, and the silent outcome — the tile quietly
 * missing from every client — is exactly the failure that goes unnoticed
 * until someone asks why the Instagram mission never appeared. Failing the
 * boot puts the discovery at deploy time, next to the change that caused it.
 *
 * THE HOST ALLOWLIST IS THE SECURITY PART. These URLs are served to every
 * client and opened in an external browser on the user's device. Pinning each
 * one to its own platform's domains means a typo — or a compromised env
 * store — cannot turn the Rewards Center into a phishing funnel carrying Red
 * Panda's branding.
 *
 * VALIDATED UNCONDITIONALLY, not only when `REWARDS_ENABLED=true`, matching
 * `REWARDS_TIMEZONE` above: a deployment that sets a broken URL while the
 * feature is dark should find out when it sets it, not weeks later when
 * someone flips the flag.
 *
 * NOT CHECKED HERE: whether the profile path is a real Red Panda account
 * rather than a template placeholder like `/your-handle`. That is
 * indistinguishable from a real handle by shape alone, so it belongs with the
 * other placeholder rules in `production-preflight/preflight.ts`, which is
 * where `https://api.example.com` is already caught for the same reason.
 */
function validateRewardsSocialUrls(config: Record<string, unknown>): void {
  for (const mission of SOCIAL_MISSION_DEFINITIONS) {
    const raw = config[mission.envKey];

    // Unset or blank: this deployment does not run this mission.
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      continue;
    }

    const rejection = rejectSocialUrl(raw, mission);

    if (rejection !== null) {
      throw new Error(
        `Invalid ${mission.envKey}=${JSON.stringify(raw)}: ` +
          `${explainSocialUrlRejection(rejection, mission.allowedHosts)} ` +
          'This value is served to every client and opened in an external ' +
          `browser, so the "${mission.id}" mission is refused rather than ` +
          'pointed somewhere unintended. Unset the variable to disable the ' +
          'mission entirely.',
      );
    }
  }
}

/**
 * The rejection reason as a sentence an operator can act on.
 *
 * THE VALUE IS ECHOED by the caller, deliberately and unlike every
 * secret-bearing validator in this file — a public social profile URL is not
 * a secret, it is a link about to be shown to every user, and naming it is
 * what makes the failure obvious at a glance.
 */
function explainSocialUrlRejection(
  rejection: SocialUrlRejection,
  allowedHosts: readonly string[],
): string {
  switch (rejection) {
    case 'NOT_A_STRING':
      return 'it must be a non-empty string.';
    case 'NOT_A_URL':
      return 'it must be an absolute URL (for example https://www.instagram.com/redpanda).';
    case 'NOT_HTTPS':
      return 'it must use https — Android 9+ refuses cleartext, so an http:// link would silently fail to open.';
    case 'WRONG_HOST':
      return `its host must be one of: ${allowedHosts.join(', ')}.`;
    case 'NO_PROFILE_PATH':
      return 'it must point at a profile, not the platform home page (the path is empty).';
  }
}

/**
 * PRODUCTION HTTPS READINESS: every configured value that becomes a URL the
 * ANDROID CLIENT must fetch has to be a public https origin in production.
 *
 * WHY ONE RULE ACROSS SEVERAL VARIABLES. These are not four cosmetic
 * settings; each one is stamped verbatim into a response the phone then
 * tries to load, and each fails the same silent way — the API answers 200,
 * `npm run smoke:production` is the only thing that would notice, and
 * playback simply never starts on a device:
 *
 *  - `PUBLIC_BASE_URL`      -> `playbackUrl` of every LOCAL-storage row
 *                              (`VideosService.getPlaybackUrl`,
 *                              `toVideoResponseDto`).
 *  - `OBJECT_STORAGE_ENDPOINT` -> the ORIGIN of every presigned GET URL, i.e.
 *                              `playbackUrl` for every R2-backed row AND the
 *                              `coverUrl` of every series. This one is easy
 *                              to miss because it reads like an internal
 *                              infrastructure endpoint, and it is not: the
 *                              AWS SDK signs a URL against it and that URL is
 *                              handed straight to the client.
 *  - `HLS_GATEWAY_BASE_URL` -> `masterUrl` and every rendition URL of an
 *                              HLS-ready row (`tryBuildHlsPlaybackResponse`).
 *  - `OBJECT_STORAGE_PUBLIC_BASE_URL` -> `StorageService.buildPublicUrl`.
 *                              Has no production caller today, so it is
 *                              checked only WHEN SET rather than required —
 *                              but if a deployment does set it, a cleartext
 *                              or LAN value is still wrong.
 *
 * `DATABASE_URL` and `REDIS_URL` are deliberately ABSENT from this list.
 * They are genuine internal infrastructure — nothing hands them to a client
 * — and a platform's private Postgres/Redis hostname is frequently exactly
 * the kind of internal address the rules below reject. Forcing them through
 * this check would break correct deployments for no security gain.
 *
 * GATED ON `NODE_ENV === 'production'`, and deliberately the OPPOSITE
 * polarity to `validateDevToolsNodeEnv`'s allowlist. That guard asks "is
 * this definitely a dev environment?" and treats an unrecognized `NODE_ENV`
 * as unsafe. This one asks "is this definitely production?" and treats an
 * unrecognized value as NOT production — the safe direction here, because
 * the rule must not fire on the LAN URL every developer and CI run
 * legitimately uses (`http://YOUR_MAC_IP:3000`, `http://localhost:3000`).
 * A deployment that forgets `NODE_ENV=production` loses this check, but it
 * also loses the dev-tools and Midtrans guards, which is why that variable
 * is listed as mandatory in `.env.production.example`.
 */
function validateProductionPublicUrls(config: Record<string, unknown>): void {
  if (config.NODE_ENV !== 'production') {
    return;
  }

  assertProductionPublicUrl(config.PUBLIC_BASE_URL, {
    key: 'PUBLIC_BASE_URL',
    consequence:
      'This value is stamped into the playbackUrl of every local-storage video row.',
  });

  // Only meaningful in r2 mode — in `local` mode no S3 client is ever used
  // to sign anything, so an unset/placeholder endpoint is harmless.
  if (resolveConfiguredStorageDriver(config) === 'r2') {
    assertProductionPublicUrl(config.OBJECT_STORAGE_ENDPOINT, {
      key: 'OBJECT_STORAGE_ENDPOINT',
      consequence:
        'Every presigned GET URL is signed against this origin, so it becomes the ' +
        'playbackUrl of every R2-backed row and the coverUrl of every series.',
    });
  }

  // Mirrors `validateHlsGatewayConfig`'s flag gate exactly: while
  // `TRANSCODE_ENABLED` is not the literal string "true" (this repo's
  // shipped default) the gateway is never consulted and the variable is not
  // required to be set at all.
  if (config.TRANSCODE_ENABLED === 'true') {
    assertProductionPublicUrl(config.HLS_GATEWAY_BASE_URL, {
      key: 'HLS_GATEWAY_BASE_URL',
      consequence:
        'It is stamped into the masterUrl and every rendition URL of an HLS-ready row.',
    });
  }

  // OPTIONAL in every mode (see `REQUIRED_R2_KEYS`) — validated only when a
  // deployment has actually set it.
  if (isNonBlankString(config.OBJECT_STORAGE_PUBLIC_BASE_URL)) {
    assertProductionPublicUrl(config.OBJECT_STORAGE_PUBLIC_BASE_URL, {
      key: 'OBJECT_STORAGE_PUBLIC_BASE_URL',
      consequence:
        'StorageService.buildPublicUrl assembles client-facing object URLs from it.',
    });
  }

  // LAST WITHIN THIS BLOCK. Every rule above concerns a URL the app HANDS
  // OUT and without which nothing plays; a stale browser origin in the
  // allowlist is a real problem but never the one to report first.
  validateProductionCorsOrigins(config);
}

interface ProductionPublicUrlRule {
  key: string;
  /** What this particular variable breaks. Appended to the error so the message is actionable, not generic. */
  consequence: string;
}

/**
 * The four checks, ordered most-fundamental-first so the reported reason is
 * the one an operator should act on: an unparseable string is not "not
 * https", and an http URL is not "a LAN address".
 *
 * THE VALUE IS ECHOED, deliberately, unlike every secret-bearing validator
 * in this file. A public base URL is not a secret — it is the origin about
 * to be published in a store listing — and naming it is what makes the
 * failure obvious at a glance.
 */
function assertProductionPublicUrl(
  raw: unknown,
  { key, consequence }: ProductionPublicUrlRule,
): void {
  if (typeof raw !== 'string') {
    throw new Error(
      `Invalid ${key}: must be an absolute https URL when NODE_ENV=production. ` +
        consequence,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `Invalid ${key}=${JSON.stringify(raw)}: must be an absolute URL ` +
        '(for example https://api.example.com) when NODE_ENV=production.',
    );
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(
      `Refusing to boot with NODE_ENV=production and ${key}=${JSON.stringify(raw)}: ` +
        `it must use https. ${consequence} Android 9+ refuses cleartext, so an ` +
        'http:// value produces an API that answers 200 while nothing can play.',
    );
  }

  if (isLoopbackHostname(parsed.hostname)) {
    throw new Error(
      `Refusing to boot with NODE_ENV=production and ${key}=${JSON.stringify(raw)}: ` +
        `"${parsed.hostname}" is a loopback address. On a phone it resolves to the ` +
        `phone itself, never to this server. ${consequence}`,
    );
  }

  if (isPrivateHostname(parsed.hostname)) {
    throw new Error(
      `Refusing to boot with NODE_ENV=production and ${key}=${JSON.stringify(raw)}: ` +
        `"${parsed.hostname}" is a private/LAN address, unreachable from the public ` +
        `internet — it works on the office wifi and nowhere else. ${consequence}`,
    );
  }
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * PRODUCTION HTTPS READINESS / CORS. Two independent problems, one
 * validator.
 *
 * 1. PRESENCE, WITHOUT REQUIRING A VALUE. `CORS_ORIGINS` used to sit in
 *    `REQUIRED_KEYS`, whose loop rejects any FALSY value — so an EMPTY
 *    value failed the boot with "Missing required environment variable".
 *    But empty is the CORRECT answer for this product: V1 is a mobile-only
 *    Android client, which is not a browser, sends no `Origin` header, and
 *    is completely unaffected by CORS. Deny-all is the intended posture and
 *    an empty list is the only way to express it. The shipped
 *    `.env.production.example` sets `CORS_ORIGINS=` and
 *    `docs/PRODUCTION_DEPLOYMENT_REQUIREMENTS.md` documents empty as valid,
 *    so the old rule made a release owner following the contract exactly end
 *    up with a process that would not start. The variable must still be
 *    DECLARED — an operator should choose deny-all, not forget the line.
 *
 * 2. THE `*` TRAP, checked in EVERY environment, not just production.
 *    `configuration.ts` always parses this variable into an ARRAY, and Nest
 *    hands that array to the `cors` package, which compares each entry to
 *    the request's `Origin` with `===`. Its wildcard branch only triggers
 *    for the literal STRING `'*'`, which an array can never be. So
 *    `CORS_ORIGINS=*` does not mean "allow everything" — it means "allow an
 *    origin whose name is exactly `*`", i.e. nothing at all. It fails safe,
 *    but silently and in the opposite direction from what whoever typed it
 *    intended, so it is never what anyone wants in any environment.
 *
 * 3. PRODUCTION ORIGIN SHAPE. Only under `NODE_ENV=production`, each entry
 *    must be a bare https origin. The trailing-slash rule is not pedantry:
 *    a browser's `Origin` header is always exactly `scheme://host[:port]`
 *    with no path, so `https://admin.example.com/` — the shape a person
 *    naturally copies out of a browser address bar — silently matches
 *    nothing and looks like a broken API rather than a config typo.
 */
function validateCorsOrigins(config: Record<string, unknown>): void {
  if (!('CORS_ORIGINS' in config)) {
    throw new Error(
      'Missing required environment variable: CORS_ORIGINS. It must be ' +
        'DECLARED, but an EMPTY value is valid and is the right answer for a ' +
        'mobile-only deployment (the Android app is not a browser and sends no ' +
        'Origin header). Set `CORS_ORIGINS=` to allow no browser origin at all, ' +
        'or a comma-separated list of exact origins for a web admin.',
    );
  }

  const raw = config.CORS_ORIGINS;

  if (typeof raw !== 'string') {
    throw new Error(
      'Invalid CORS_ORIGINS: must be a comma-separated list of exact origins ' +
        '(empty means allow no browser origin).',
    );
  }

  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  for (const origin of origins) {
    if (origin === '*') {
      throw new Error(
        'Invalid CORS_ORIGINS entry "*": this app parses CORS_ORIGINS into a ' +
          'LIST of exact origins, which the cors package matches with string ' +
          'equality — so "*" does not allow every origin, it allows an origin ' +
          'literally named "*", i.e. nothing. Remove it: leave CORS_ORIGINS ' +
          'empty to allow no browser origin, or list the exact origins you mean.',
      );
    }
  }

  // The PRODUCTION origin-shape rules deliberately do NOT live here. They
  // run from `validateProductionPublicUrls`, which `validateEnv` calls LAST
  // — see that call site's comment. Checked here, a dev origin left in a
  // production allowlist would PREEMPT the dev-tools/Midtrans security
  // guards and the PUBLIC_BASE_URL check, reporting the least important
  // problem first.
}

/**
 * The `NODE_ENV=production` half of the CORS contract, invoked from
 * `validateProductionPublicUrls` so it shares that block's deliberate
 * run-last ordering.
 */
function validateProductionCorsOrigins(config: Record<string, unknown>): void {
  const raw = config.CORS_ORIGINS;

  if (typeof raw !== 'string') {
    return; // already reported by `validateCorsOrigins`.
  }

  for (const origin of raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)) {
    assertProductionCorsOrigin(origin);
  }
}

function assertProductionCorsOrigin(origin: string): void {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(
      `Invalid CORS_ORIGINS entry ${JSON.stringify(origin)}: each entry must be an ` +
        'absolute origin (for example https://admin.example.com) when ' +
        'NODE_ENV=production.',
    );
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(
      `Refusing to boot with NODE_ENV=production and CORS_ORIGINS entry ` +
        `${JSON.stringify(origin)}: a production browser origin must use https.`,
    );
  }

  if (
    isLoopbackHostname(parsed.hostname) ||
    isPrivateHostname(parsed.hostname)
  ) {
    throw new Error(
      `Refusing to boot with NODE_ENV=production and CORS_ORIGINS entry ` +
        `${JSON.stringify(origin)}: ${JSON.stringify(parsed.hostname)} is a ` +
        'loopback/LAN host. A development origin left in a production ' +
        "allowlist grants a page on someone's own machine access to this API.",
    );
  }

  // `new URL('https://admin.example.com').pathname` is '/', so this rejects
  // only a REAL path, a trailing slash the operator typed, a query string or
  // a fragment — every one of which makes the entry match nothing.
  const hasExtraParts =
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    origin.endsWith('/');

  if (hasExtraParts) {
    throw new Error(
      `Invalid CORS_ORIGINS entry ${JSON.stringify(origin)}: an entry must be a ` +
        'bare origin with no path, query, fragment or trailing slash ' +
        `(use ${JSON.stringify(parsed.origin)}). A browser's Origin header is ` +
        'always exactly scheme://host[:port], so anything longer matches nothing.',
    );
  }
}

/**
 * PRODUCTION HTTPS READINESS: `TRUST_PROXY_HOPS` is OPTIONAL (it has a
 * documented default, `DEFAULT_TRUST_PROXY_HOPS = 0`), following the exact
 * "optional, but must be well-formed if present" pattern
 * `assertPositiveIntEnvIfPresent` established for the transcode knobs.
 *
 * It gets its own validator rather than reusing that helper for one reason:
 * ZERO IS A LEGITIMATE VALUE HERE. `TRUST_PROXY_HOPS=0` is the explicit "no
 * proxy is in front of this process" answer, and `assertPositiveIntEnvIfPresent`
 * rejects `0` outright (and names `TRANSCODE_ENABLED` in its error message,
 * which has nothing to do with this variable).
 *
 * VALIDATED UNCONDITIONALLY, not behind a feature flag: unlike the transcode
 * and payment knobs, this value is read on EVERY request path in every
 * deployment, and a typo (`"one"`, `"1 "`, `"-1"`, `"1.5"`) would otherwise
 * fall back silently to 0 and re-open the collapsed-rate-limit failure the
 * variable exists to close. Failing the boot makes that impossible to deploy
 * unnoticed. The value is a small integer, never a secret, so — unlike the
 * secret-bearing validators in this file — it IS safe to echo back, and
 * naming the bad value is what makes the error actionable.
 */
function validateTrustProxyHops(config: Record<string, unknown>): void {
  const raw = config.TRUST_PROXY_HOPS;

  if (raw === undefined || raw === null) {
    return; // genuinely unset — the default (0) applies.
  }

  if (typeof raw !== 'string') {
    throw new Error(
      'Invalid TRUST_PROXY_HOPS: must be a non-negative integer when set ' +
        '(0 = no reverse proxy, 1 = one proxy in front of this process).',
    );
  }

  if (raw.trim().length === 0) {
    return; // blank string — treated as "not set".
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `Invalid TRUST_PROXY_HOPS=${JSON.stringify(raw)}: must be a ` +
        'non-negative integer (0 = no reverse proxy, 1 = one proxy in front ' +
        'of this process). A malformed value would silently disable proxy ' +
        'awareness and collapse every per-IP rate limit onto a single bucket.',
    );
  }
}

/**
 * Phase 10, work unit 10-B5 originally added this as a denylist
 * (`config.NODE_ENV === 'production'`) so dev-only entitlement grant/revoke
 * routes could never be reachable in a production deployment. The Phase 12,
 * work unit 12D-B2 security review escalated that denylist to HIGH: an
 * unset, empty, misspelled, or differently-cased `NODE_ENV` (e.g.
 * `"Production"`) silently passed the old `!== 'production'`-shaped check,
 * and the same `DEV_TOOLS_ENABLED` flag also gates the entire `/dev/*`
 * surface — including `/dev/admin/*`'s self-service admin-role grant/revoke
 * routes (`AdminController`), not just `/dev/entitlements/*`. Under that
 * misconfiguration a caller could grant themselves admin: a
 * privilege-escalation path, not merely a dev-token leak.
 *
 * Replaced with a fail-closed ALLOWLIST, mirroring the shape
 * `src/retention/retention-env-guard.ts` established one work unit earlier
 * (12D-B1) for exactly the same reason (`TASK_QUEUE.md` follow-up item 5):
 * `undefined`, `''`, a typo, or any value not explicitly recognized as safe
 * is treated as UNSAFE by default, never as "probably fine because it isn't
 * literally the word production". Deliberately NOT imported from that file —
 * its own doc comment states it is an independent gate specific to the
 * retention job, and this fix is scoped to `env.validation.ts` only.
 */
const DEV_TOOLS_ALLOWED_NODE_ENVS = ['development', 'test'] as const;

function validateDevToolsNodeEnv(config: Record<string, unknown>): void {
  if (config.DEV_TOOLS_ENABLED !== 'true') {
    return;
  }

  const nodeEnv =
    typeof config.NODE_ENV === 'string' ? config.NODE_ENV : undefined;
  const isAllowed = (DEV_TOOLS_ALLOWED_NODE_ENVS as readonly string[]).includes(
    nodeEnv ?? '',
  );

  if (!isAllowed) {
    throw new Error(
      'Refusing to boot with DEV_TOOLS_ENABLED=true: ' +
        `NODE_ENV=${JSON.stringify(nodeEnv ?? null)} is not one of the ` +
        `explicitly allowed values (${DEV_TOOLS_ALLOWED_NODE_ENVS.join(', ')}). ` +
        'This is a fail-closed ALLOWLIST, not a "!== production" check — an ' +
        'unset, empty, misspelled, or differently-cased NODE_ENV (including ' +
        'literally "production") is treated as unsafe by default. Dev-only ' +
        'entitlement grant/revoke routes and the /dev/admin/* self-service ' +
        'admin-role-grant routes must never be reachable outside an ' +
        'explicit development/test environment.',
    );
  }
}

/**
 * Phase 11, work unit 11G-3: `STORAGE_DRIVER` feature flag validation.
 * Unset/empty resolves to `local` (byte-for-byte existing behavior — only
 * `STORAGE_ROOT`, already checked above, is required). Any value other
 * than `local`/`r2` fails fast with a clear, secret-free message. In `r2`
 * mode, fails fast if any required `OBJECT_STORAGE_*` env var NAME is
 * missing/empty (the error names the variable, never its value) and, if an
 * endpoint is present, rejects a malformed `OBJECT_STORAGE_ENDPOINT`
 * (shape check only — this never makes a network request, never connects
 * to R2, and never validates credentials against a live endpoint).
 */
/**
 * The single place `STORAGE_DRIVER` is turned into a driver name, shared by
 * `validateStorageDriver` (which decides whether the `OBJECT_STORAGE_*`
 * names are required) and `validateProductionPublicUrls` (which decides
 * whether `OBJECT_STORAGE_ENDPOINT` has to be a public https origin).
 * Extracted rather than duplicated: if the two ever disagreed about what
 * `STORAGE_DRIVER=` resolves to, an r2 deployment could pass one check and
 * skip the other. Returns the RAW string when unrecognized so
 * `validateStorageDriver` can still name it in its own error.
 */
function resolveConfiguredStorageDriver(
  config: Record<string, unknown>,
): string {
  const rawDriver = config.STORAGE_DRIVER;
  return typeof rawDriver === 'string' && rawDriver.trim().length > 0
    ? rawDriver
    : DEFAULT_STORAGE_DRIVER;
}

function validateStorageDriver(config: Record<string, unknown>): void {
  const driver = resolveConfiguredStorageDriver(config);

  if (!STORAGE_DRIVERS.includes(driver as StorageDriver)) {
    throw new Error(
      `Invalid STORAGE_DRIVER: "${driver}". Must be one of: ${STORAGE_DRIVERS.join(', ')}.`,
    );
  }

  if (driver !== 'r2') {
    return;
  }

  for (const key of REQUIRED_R2_KEYS) {
    if (!config[key]) {
      throw new Error(
        `Missing required environment variable: ${key}. STORAGE_DRIVER=r2 requires every OBJECT_STORAGE_* variable to be set (see .env.example). Values are never logged.`,
      );
    }
  }

  const endpoint = String(config.OBJECT_STORAGE_ENDPOINT);

  if (!isValidObjectStorageEndpoint(endpoint)) {
    throw new Error(
      'OBJECT_STORAGE_ENDPOINT must be a valid absolute http(s) URL when ' +
        'STORAGE_DRIVER=r2 (shape check only — no network request is made).',
    );
  }
}

/** Shape check only — never resolves DNS or opens a connection. */
function isValidObjectStorageEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Slice 11N: `TRANSCODE_ENABLED` feature flag + conditionally required
 * `REDIS_URL`, mirroring `validateStorageDriver`'s r2-conditional shape
 * exactly (2026-08-10 DECISIONS.md approval: "REDIS_URL — validated as
 * REQUIRED only when TRANSCODE_ENABLED=true ... mirror the 11G-3 conditional
 * env-var pattern"). `TRANSCODE_ENABLED` not being the exact string `"true"`
 * needs nothing extra — the default, safe posture, and the ONLY posture this
 * slice ever ships (`TRANSCODE_ENABLED=true` is a hard prohibition outside
 * explicitly-scoped, queue-mocking tests). `"true"` requires `REDIS_URL` to
 * be present (name/shape only — never a network probe, never logs the
 * value, matching `validateStorageDriver`'s `OBJECT_STORAGE_ENDPOINT` shape
 * check).
 */
function validateTranscodeConfig(config: Record<string, unknown>): void {
  if (config.TRANSCODE_ENABLED !== 'true') {
    return;
  }

  // Captured BEFORE the presence check below narrows the `config.REDIS_URL`
  // property-access expression itself (TS narrows a truthy-checked `unknown`
  // property to `{}`, which lacks a meaningful `toString` and would trip
  // `no-base-to-string` at the `String()` call further down) — `rawRedisUrl`
  // is a separate local binding untouched by that narrowing, so `String()`
  // below still runs against the original, un-narrowed `unknown`, matching
  // `validateStorageDriver`'s `String(config.OBJECT_STORAGE_ENDPOINT)` usage
  // above exactly.
  const rawRedisUrl = config.REDIS_URL;

  if (!config.REDIS_URL) {
    throw new Error(
      'Missing required environment variable: REDIS_URL. TRANSCODE_ENABLED=true requires REDIS_URL to be set (see .env.example). Values are never logged.',
    );
  }

  const redisUrl = String(rawRedisUrl);

  if (!isValidRedisUrl(redisUrl)) {
    throw new Error(
      'REDIS_URL must be a valid redis:// or rediss:// URL when TRANSCODE_ENABLED=true (shape check only — no network connection is made).',
    );
  }

  // Slice 11P: TRANSCODE_MAX_ATTEMPTS / TRANSCODE_STALLED_AFTER_MINUTES /
  // TRANSCODE_CLEANUP_GRACE_MINUTES are all OPTIONAL (each has a documented
  // default in `configuration.ts`) even when TRANSCODE_ENABLED=true — unlike
  // REDIS_URL above, nothing here requires them to be SET. What this DOES
  // require, mirroring `validateStorageDriver`'s conditional-shape-check
  // pattern: if one IS present, it must parse as a positive integer, or boot
  // fails loudly and names the offending variable (never echoes the actual
  // malformed value, matching every other error in this file).
  assertPositiveIntEnvIfPresent(config, 'TRANSCODE_MAX_ATTEMPTS');
  assertPositiveIntEnvIfPresent(config, 'TRANSCODE_STALLED_AFTER_MINUTES');
  assertPositiveIntEnvIfPresent(config, 'TRANSCODE_CLEANUP_GRACE_MINUTES');
}

/** Shape check only — never resolves DNS or opens a connection. */
function assertPositiveIntEnvIfPresent(
  config: Record<string, unknown>,
  key: string,
): void {
  const raw = config[key];

  if (raw === undefined || raw === null) {
    return; // genuinely unset — nothing to validate.
  }

  // `raw` is narrowed to `string` below (never calling `String()` on an
  // arbitrary `unknown` value, which would trip `no-base-to-string` — env
  // config values are always strings in practice; a non-string here is
  // itself an invalid/unexpected shape, not something to coerce).
  if (typeof raw !== 'string') {
    throw new Error(
      `Invalid ${key}: must be a positive integer when set (see .env.example). TRANSCODE_ENABLED=true is active, so this value is read.`,
    );
  }

  if (raw.trim().length === 0) {
    return; // blank string — treated as "not set".
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid ${key}: must be a positive integer when set (see .env.example). TRANSCODE_ENABLED=true is active, so this value is read.`,
    );
  }
}

/**
 * Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION": `PAYMENTS_ENABLED`
 * feature flag + conditionally required `MIDTRANS_SERVER_KEY`, mirroring
 * `validateTranscodeConfig`'s flag-conditional shape exactly. While the flag
 * is not the literal string `"true"` (the default, and this slice's only
 * shipped posture), no `MIDTRANS_*` variable is required at all.
 *
 * Two independent fail-closed rules:
 *
 * 1. `PAYMENTS_ENABLED=true` requires `MIDTRANS_SERVER_KEY` to be present
 *    (name-presence only — the value is never read into an error message,
 *    never logged, and no network call is made here). Without it, nothing
 *    could authenticate a Snap create call or verify a webhook signature,
 *    and both would otherwise fail at request time in a less obvious way.
 *
 * 2. `MIDTRANS_IS_PRODUCTION=true` is refused unless `NODE_ENV` is exactly
 *    `"production"` — an ALLOWLIST, deliberately the mirror image of
 *    `validateDevToolsNodeEnv` above: that guard keeps dev-only surfaces
 *    out of production; this one keeps the PRODUCTION (real-money) Midtrans
 *    endpoint out of development/test. An unset, empty, misspelled, or
 *    differently-cased `NODE_ENV` is treated as NOT production, so the
 *    production endpoint can never be reached by accident. This check runs
 *    even while `PAYMENTS_ENABLED` is false — a mis-set production flag is
 *    a config error worth failing loudly on before it is ever activated.
 */
function validatePaymentsConfig(config: Record<string, unknown>): void {
  if (
    config.MIDTRANS_IS_PRODUCTION === 'true' &&
    config.NODE_ENV !== 'production'
  ) {
    throw new Error(
      'Refusing to boot with MIDTRANS_IS_PRODUCTION=true: NODE_ENV is not ' +
        'exactly "production". The production Midtrans endpoint processes ' +
        'real money and must never be reachable from a development/test ' +
        'environment. Unset MIDTRANS_IS_PRODUCTION (sandbox is the default) ' +
        'or run with NODE_ENV=production. Values are never logged.',
    );
  }

  if (config.PAYMENTS_ENABLED !== 'true') {
    return;
  }

  if (!config.MIDTRANS_SERVER_KEY) {
    throw new Error(
      'Missing required environment variable: MIDTRANS_SERVER_KEY. ' +
        'PAYMENTS_ENABLED=true requires MIDTRANS_SERVER_KEY to be set ' +
        '(see .env.example). Values are never logged.',
    );
  }
}

/** Shape check only — never resolves DNS or opens a connection. */
function isValidRedisUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'redis:' || url.protocol === 'rediss:';
  } catch {
    return false;
  }
}

/**
 * Slice 11Q: `HLS_GATEWAY_BASE_URL`/`HLS_TOKEN_SECRET` are validated only
 * when `TRANSCODE_ENABLED === 'true'` — mirroring `validateTranscodeConfig`'s
 * REDIS_URL-conditional shape exactly (2026-08-10 DECISIONS.md approval:
 * "Config (11G-3 conditional pattern): HLS_GATEWAY_BASE_URL, HLS_TOKEN_SECRET
 * ... validated as present + distinct-from-JWT-secrets when
 * TRANSCODE_ENABLED=true"). While the flag is `false` (this repo's only
 * shipped state), neither variable is required to be set at all — and even
 * if `TRANSCODE_ENABLED` is somehow `true` in some future environment,
 * `VideosService`'s own runtime check (`HLS_GATEWAY_NOT_CONFIGURED`) is a
 * SECOND, independent fail-closed guard at the point of use, not a
 * substitute for this boot-time check.
 *
 * `HLS_TOKEN_SECRET` must also be DISTINCT from every other signing secret
 * this app already uses (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
 * `AUTH_AUDIT_IP_HASH_SECRET`) — reusing one would mean a Worker-side
 * (or leaked) HLS token secret could be used to forge the value another
 * secret protects, or vice versa. Never logs any of the compared values —
 * only ever names which two variables collided.
 */
function validateHlsGatewayConfig(config: Record<string, unknown>): void {
  if (config.TRANSCODE_ENABLED !== 'true') {
    return;
  }

  // Captured BEFORE the presence checks below narrow each `config.X`
  // property-access expression itself — see `validateTranscodeConfig`'s
  // `rawRedisUrl` comment above for why this avoids tripping
  // `no-base-to-string` at the `String()` calls further down.
  const rawHlsTokenSecret = config.HLS_TOKEN_SECRET;
  const rawBaseUrl = config.HLS_GATEWAY_BASE_URL;

  if (!config.HLS_TOKEN_SECRET) {
    throw new Error(
      'Missing required environment variable: HLS_TOKEN_SECRET. TRANSCODE_ENABLED=true requires HLS_TOKEN_SECRET to be set (see .env.example). Values are never logged.',
    );
  }

  const hlsTokenSecret = String(rawHlsTokenSecret);
  const otherSecretKeys = [
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET',
    'AUTH_AUDIT_IP_HASH_SECRET',
  ] as const;

  for (const otherKey of otherSecretKeys) {
    // `rawOtherSecret` is deliberately never used inside the `if` guard's
    // own condition below (only `config[otherKey]` is) — using the SAME
    // variable in both the truthy check and the `String()` call would let
    // TS narrow it to `{}` for the check, which is what trips
    // `no-base-to-string` (see the `rawHlsTokenSecret`/`rawBaseUrl`
    // comment above for the same pattern).
    const rawOtherSecret = config[otherKey];
    if (!config[otherKey]) {
      continue;
    }
    if (String(rawOtherSecret) === hlsTokenSecret) {
      throw new Error(
        `Invalid HLS_TOKEN_SECRET: must be DISTINCT from ${otherKey} (see .env.example). Values are never logged — only variable names are compared.`,
      );
    }
  }

  if (!config.HLS_GATEWAY_BASE_URL) {
    throw new Error(
      'Missing required environment variable: HLS_GATEWAY_BASE_URL. TRANSCODE_ENABLED=true requires HLS_GATEWAY_BASE_URL to be set (see .env.example). Values are never logged.',
    );
  }

  const baseUrl = String(rawBaseUrl);
  if (!isValidObjectStorageEndpoint(baseUrl)) {
    throw new Error(
      'HLS_GATEWAY_BASE_URL must be a valid absolute http(s) URL when TRANSCODE_ENABLED=true (shape check only — no network request is made).',
    );
  }

  // HLS_TOKEN_TTL_SECONDS is OPTIONAL even when TRANSCODE_ENABLED=true (it
  // has a documented default, DEFAULT_HLS_TOKEN_TTL_SECONDS) — mirroring
  // the TRANSCODE_MAX_ATTEMPTS/etc. "optional, but must be a positive
  // integer if present" pattern immediately above.
  assertPositiveIntEnvIfPresent(config, 'HLS_TOKEN_TTL_SECONDS');
}

/**
 * PHASE 10B — PRODUCTION IDENTITY PROVIDERS. Boot-time, fail-closed
 * validation for the Google and WhatsApp providers, following the exact
 * `validatePaymentsConfig`/`validateTranscodeConfig` conditional shape:
 * nothing here is required while the corresponding feature flag is off
 * (this repository's shipped default), and nothing here ever reads, logs or
 * echoes a value — only variable NAMES appear in error messages.
 *
 * EMAIL/PASSWORD IS NOT VALIDATED HERE because it is not optional and has
 * no flag. `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`/
 * `AUTH_AUDIT_IP_HASH_SECRET` are already unconditionally required by
 * `REQUIRED_KEYS` above, which is exactly right: email/password sign-in
 * must work in every environment, and this phase must not create a
 * configuration in which it does not.
 */
function validateIdentityProvidersConfig(
  config: Record<string, unknown>,
): void {
  validateGoogleAuthConfig(config);
  validateWhatsAppConfig(config);
}

/**
 * `GOOGLE_OAUTH_CLIENT_IDS` is required (name presence only) when
 * `GOOGLE_AUTH_ENABLED=true`, because a verifier with an empty audience
 * allowlist can accept nothing — it would answer 401 to every legitimate
 * sign-in, which is a far more confusing failure than refusing to boot.
 * `GoogleOidcIdentityVerifier`'s constructor enforces the same invariant
 * independently, so this check is the early, legible half of a
 * belt-and-braces pair, not the only one.
 *
 * NOTHING SECRET IS REQUIRED, and that is worth stating explicitly rather
 * than leaving as an omission a later reviewer must infer: verifying a
 * Google ID token needs Google's PUBLIC signing keys and this server's
 * client id (itself public — it ships in the mobile app binary). The OAuth
 * client SECRET belongs to the authorization-code exchange, which happens
 * on the CLIENT in this architecture; this backend never performs that
 * exchange, never reads a client secret, and therefore cannot leak one.
 */
function validateGoogleAuthConfig(config: Record<string, unknown>): void {
  if (config.GOOGLE_AUTH_ENABLED !== 'true') {
    return;
  }

  // Captured BEFORE the presence check below narrows the `config.X`
  // property-access expression itself — see `validateTranscodeConfig`'s
  // `rawRedisUrl` comment for why this avoids tripping `no-base-to-string`
  // at the `String()` call further down.
  const rawClientIds = config.GOOGLE_OAUTH_CLIENT_IDS;
  if (!config.GOOGLE_OAUTH_CLIENT_IDS) {
    throw new Error(
      'Missing required environment variable: GOOGLE_OAUTH_CLIENT_IDS. ' +
        'GOOGLE_AUTH_ENABLED=true requires at least one Google OAuth client id ' +
        '(comma-separated for multiple platforms; see .env.example). ' +
        'Values are never logged.',
    );
  }

  const hasNonEmptyEntry = String(rawClientIds)
    .split(',')
    .some((entry) => entry.trim().length > 0);

  if (!hasNonEmptyEntry) {
    throw new Error(
      'Invalid GOOGLE_OAUTH_CLIENT_IDS: GOOGLE_AUTH_ENABLED=true requires at ' +
        'least one non-empty client id. A blank or comma-only value would ' +
        'produce a verifier that rejects every token. Values are never logged.',
    );
  }
}

/**
 * PHASE 10B — the guard that makes the local fake OTP provider impossible in
 * production.
 *
 * Two independent rules, in the order they matter:
 *
 * 1. `WHATSAPP_OTP_PROVIDER_DRIVER=fake` is refused unless `NODE_ENV` is
 *    EXACTLY `development` or `test` — a fail-closed ALLOWLIST, deliberately
 *    the same shape as `validateDevToolsNodeEnv` above, and for the same
 *    reason that check was escalated from a denylist after review: an unset,
 *    empty, misspelled or differently-cased `NODE_ENV` (e.g. `"Production"`)
 *    silently passes a `!== 'production'` test. The fake provider retains
 *    plaintext OTP codes in memory and sends no message at all, so a
 *    production deployment running it would appear to work while every
 *    verification code was undeliverable — and any operator (or attacker)
 *    with access to a `devCode`-enabled response could sign in as any phone
 *    number. This check runs even when `WHATSAPP_AUTH_ENABLED` is false: a
 *    mis-set driver is a configuration error worth failing loudly on before
 *    it is ever activated, exactly as `validatePaymentsConfig` treats
 *    `MIDTRANS_IS_PRODUCTION`.
 *
 * 2. With `WHATSAPP_AUTH_ENABLED=true`, the driver must name an IMPLEMENTED
 *    provider (`WHATSAPP_OTP_DRIVERS`), and if that provider is
 *    `cloud-api`, every setting it cannot function without must be present.
 *    Combined with rule 1, a PRODUCTION deployment therefore has exactly one
 *    way to enable WhatsApp login — `cloud-api` with complete credentials —
 *    and every incomplete posture fails the BOOT rather than starting a
 *    backend that accepts OTP requests, answers 202, and silently delivers
 *    nothing. See `docs/WHATSAPP_LOGIN_SETUP.md` for what an operator must
 *    obtain from Meta.
 *
 * NOTHING HERE READS OR ECHOES A VALUE. Every message names VARIABLES only —
 * `WHATSAPP_CLOUD_API_ACCESS_TOKEN` is a real credential, and a boot error
 * is exactly the kind of text that ends up pasted into a chat window.
 */
const FAKE_WHATSAPP_ALLOWED_NODE_ENVS = ['development', 'test'] as const;

/**
 * `WHATSAPP_CLOUD_API_GRAPH_VERSION` is interpolated into the Graph API URL,
 * so its shape is constrained rather than trusted: `v` followed by
 * `<major>.<minor>`, which is the only form Meta publishes. This blocks a
 * mis-set (or hostile) value from steering the request at a different host
 * or edge — `WhatsAppCloudApiOtpProvider` additionally percent-encodes the
 * segment, making this the first of two independent guards.
 */
const GRAPH_VERSION_PATTERN = /^v\d+\.\d+$/;

/**
 * The settings `cloud-api` cannot function without. Listed as data rather
 * than four copy-pasted `if` blocks so that adding one cannot accidentally
 * ship without its check — and so the error text is identical for each.
 */
const REQUIRED_WHATSAPP_CLOUD_API_KEYS = [
  'WHATSAPP_CLOUD_API_PHONE_NUMBER_ID',
  'WHATSAPP_CLOUD_API_ACCESS_TOKEN',
  'WHATSAPP_CLOUD_API_TEMPLATE_NAME',
  'WHATSAPP_CLOUD_API_TEMPLATE_LANGUAGE',
] as const;

function validateWhatsAppConfig(config: Record<string, unknown>): void {
  const driver =
    typeof config.WHATSAPP_OTP_PROVIDER_DRIVER === 'string'
      ? config.WHATSAPP_OTP_PROVIDER_DRIVER
      : undefined;

  if (
    driver === 'fake' &&
    !(FAKE_WHATSAPP_ALLOWED_NODE_ENVS as readonly string[]).includes(
      typeof config.NODE_ENV === 'string' ? config.NODE_ENV : '',
    )
  ) {
    throw new Error(
      'Refusing to boot with WHATSAPP_OTP_PROVIDER_DRIVER=fake: NODE_ENV is ' +
        'not exactly "development" or "test". The fake provider retains ' +
        'plaintext OTP codes in memory and delivers no message, so it must ' +
        'never run outside local development or automated tests. Use ' +
        'WHATSAPP_OTP_PROVIDER_DRIVER=cloud-api for a real deployment, or run ' +
        'with NODE_ENV=development/test. Values are never logged.',
    );
  }

  // Shape-checked even while the feature is OFF, exactly as the `fake`
  // allowlist above is: a misspelled version is a configuration error worth
  // failing loudly on before it is activated, not after.
  validateGraphVersion(config);

  if (config.WHATSAPP_AUTH_ENABLED !== 'true') {
    return;
  }

  if (driver === undefined || driver.trim().length === 0) {
    throw new Error(
      'Missing required environment variable: WHATSAPP_OTP_PROVIDER_DRIVER. ' +
        'WHATSAPP_AUTH_ENABLED=true requires an explicit OTP delivery driver ' +
        `(one of: ${WHATSAPP_OTP_DRIVERS.join(', ')}; see .env.example). ` +
        'There is deliberately no default: a backend that accepts OTP ' +
        'requests without a real delivery provider would answer 202 while ' +
        'silently sending nothing.',
    );
  }

  if (!(WHATSAPP_OTP_DRIVERS as readonly string[]).includes(driver)) {
    throw new Error(
      `Unsupported WHATSAPP_OTP_PROVIDER_DRIVER: "${driver}". Implemented ` +
        `drivers are: ${WHATSAPP_OTP_DRIVERS.join(', ')}. "cloud-api" is the ` +
        'production driver (Meta WhatsApp Cloud API); "fake" delivers nothing ' +
        'and is permitted only under NODE_ENV=development/test.',
    );
  }

  if (driver === 'cloud-api') {
    validateWhatsAppCloudApiConfig(config);
  }
}

function validateGraphVersion(config: Record<string, unknown>): void {
  const rawVersion = config.WHATSAPP_CLOUD_API_GRAPH_VERSION;

  if (typeof rawVersion !== 'string' || rawVersion.trim().length === 0) {
    return;
  }

  if (!GRAPH_VERSION_PATTERN.test(rawVersion.trim())) {
    throw new Error(
      'Invalid WHATSAPP_CLOUD_API_GRAPH_VERSION: it must look like "v21.0" ' +
        '(a "v" followed by major.minor), because it is interpolated into the ' +
        'Graph API request URL. Unset it to use the version this client was ' +
        'written against.',
    );
  }
}

/**
 * The four settings `WhatsAppCloudApiOtpProvider` refuses to be constructed
 * without. Checked here so the failure names the ENVIRONMENT VARIABLE an
 * operator must set, rather than the constructor field an operator has never
 * heard of — the constructor check remains as the second, independent guard.
 */
function validateWhatsAppCloudApiConfig(config: Record<string, unknown>): void {
  for (const key of REQUIRED_WHATSAPP_CLOUD_API_KEYS) {
    const value = config[key];

    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(
        `Missing required environment variable: ${key}. ` +
          'WHATSAPP_AUTH_ENABLED=true with WHATSAPP_OTP_PROVIDER_DRIVER=cloud-api ' +
          'requires the complete WhatsApp Cloud API sender configuration — a ' +
          'partial one would accept OTP requests and deliver nothing. See ' +
          'docs/WHATSAPP_LOGIN_SETUP.md. Values are never logged.',
      );
    }
  }
}

/**
 * Work unit "V1 FREE ACCESS POLICY": `CONTENT_ACCESS_MODE` policy-name
 * validation, shaped after `validateStorageDriver` above. Unset/empty
 * resolves to `entitlement` (byte-for-byte existing behavior). Any value
 * other than the two known modes fails fast with a clear, secret-free
 * message naming both.
 *
 * WHY A NAMED-MODE ALLOWLIST RATHER THAN THE `=== 'true'` FLAG SHAPE used by
 * TRANSCODE_ENABLED/PAYMENTS_ENABLED/REWARDS_ENABLED. Those flags fail
 * CLOSED on a typo: a misspelled value leaves the feature off, which is the
 * safe direction for a feature that mints money, premium, or queue work.
 * This setting has no such safe direction — one mode gates content behind
 * entitlements, the other publishes it — so "whichever mode a typo happens
 * to land on" is never acceptable, and the boot must refuse instead.
 *
 * VALIDATED UNCONDITIONALLY, like `validateRewardsConfig`'s timezone check:
 * a deployment that misspells the mode should find out when it sets it.
 */
function validateContentAccessMode(config: Record<string, unknown>): void {
  const rawMode = config.CONTENT_ACCESS_MODE;
  const mode =
    typeof rawMode === 'string' && rawMode.trim().length > 0
      ? rawMode
      : DEFAULT_CONTENT_ACCESS_MODE;

  if (!CONTENT_ACCESS_MODES.includes(mode as ContentAccessMode)) {
    throw new Error(
      `Invalid CONTENT_ACCESS_MODE: "${mode}". Must be one of: ` +
        `${CONTENT_ACCESS_MODES.join(', ')}. Unset or empty means ` +
        `"${DEFAULT_CONTENT_ACCESS_MODE}" (entitlement enforcement stays on).`,
    );
  }
}
