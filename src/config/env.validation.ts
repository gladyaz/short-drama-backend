import { existsSync, statSync } from 'fs';
import {
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

  validateDevToolsNodeEnv(config);

  return config;
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
