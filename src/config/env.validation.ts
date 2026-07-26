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
] as const;

/**
 * Phase 11, work unit 11G-3: `OBJECT_STORAGE_*` env var NAMES required only
 * when `STORAGE_DRIVER=r2` — these are exactly the fields `StorageConfig`
 * exposes and that `StorageService`/`StorageModule` read: `bucket` (every
 * S3 command in `storage.service.ts`), `endpoint`/`region`/`accessKeyId`/
 * `secretAccessKey` (the `S3Client` constructed in `storage.module.ts`),
 * and `publicBaseUrl` (`StorageService.buildPublicUrl`). This is
 * presence/name validation only — no value is ever read into an error
 * message and no network call is made here.
 */
const REQUIRED_R2_KEYS = [
  'OBJECT_STORAGE_ENDPOINT',
  'OBJECT_STORAGE_REGION',
  'OBJECT_STORAGE_BUCKET',
  'OBJECT_STORAGE_ACCESS_KEY_ID',
  'OBJECT_STORAGE_SECRET_ACCESS_KEY',
  'OBJECT_STORAGE_PUBLIC_BASE_URL',
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

  // Phase 10, work unit 10-B5: dev-only entitlement grant/revoke routes must
  // never be reachable in a production deployment. Fail the app's boot
  // entirely rather than silently ignoring the flag, so a misconfigured
  // production environment cannot expose these routes by accident.
  if (config.DEV_TOOLS_ENABLED === 'true' && config.NODE_ENV === 'production') {
    throw new Error(
      'DEV_TOOLS_ENABLED=true is not allowed when NODE_ENV=production. ' +
        'Dev-only entitlement grant/revoke routes must never be reachable in production.',
    );
  }

  return config;
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
