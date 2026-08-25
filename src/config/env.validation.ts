import { existsSync, statSync } from 'fs';
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
  'CORS_ORIGINS',
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

  validateStorageDriver(config);

  validateTrustProxyHops(config);

  validateDevToolsNodeEnv(config);

  validateTranscodeConfig(config);

  validateHlsGatewayConfig(config);

  validatePaymentsConfig(config);

  validateIdentityProvidersConfig(config);

  validateRewardsConfig(config);

  validateContentAccessMode(config);

  return config;
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
function validateStorageDriver(config: Record<string, unknown>): void {
  const rawDriver = config.STORAGE_DRIVER;
  const driver =
    typeof rawDriver === 'string' && rawDriver.trim().length > 0
      ? rawDriver
      : DEFAULT_STORAGE_DRIVER;

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
 *    provider. `fake` is currently the only one, because no WhatsApp vendor
 *    credentials exist for this project and no vendor client has been
 *    written or tested against them. Combined with rule 1, that means
 *    WhatsApp OTP cannot presently be enabled in production AT ALL — the
 *    process refuses to start. That is the intended, honest outcome: a
 *    backend that accepts OTP requests, answers 202, and silently delivers
 *    nothing would be strictly worse than one that will not boot. See the
 *    final report's "requirements still needed for real provider
 *    activation" section for exactly what unblocks it.
 */
const FAKE_WHATSAPP_ALLOWED_NODE_ENVS = ['development', 'test'] as const;

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
        'never run outside local development or automated tests. Unset ' +
        'WHATSAPP_OTP_PROVIDER_DRIVER, or run with NODE_ENV=development/test. ' +
        'Values are never logged.',
    );
  }

  if (config.WHATSAPP_AUTH_ENABLED !== 'true') {
    return;
  }

  if (driver === undefined || driver.trim().length === 0) {
    throw new Error(
      'Missing required environment variable: WHATSAPP_OTP_PROVIDER_DRIVER. ' +
        'WHATSAPP_AUTH_ENABLED=true requires an explicit OTP delivery driver ' +
        '(see .env.example). There is deliberately no default: a backend that ' +
        'accepts OTP requests without a real delivery provider would answer ' +
        '202 while silently sending nothing.',
    );
  }

  if (driver !== 'fake') {
    throw new Error(
      `Unsupported WHATSAPP_OTP_PROVIDER_DRIVER: "${driver}". The only ` +
        'implemented driver is "fake" (development/test only) — no WhatsApp ' +
        'vendor client ships in this build, because no vendor credentials ' +
        'exist to build or test one against. Implement a WhatsAppOtpProvider ' +
        'for the chosen vendor and register it in AuthModule before enabling ' +
        'WHATSAPP_AUTH_ENABLED in this environment.',
    );
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
