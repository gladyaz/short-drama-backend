export interface AppConfig {
  port: number;
  publicBaseUrl: string;
  storageRoot: string;
  corsOrigins: string[];
  /** Phase 10, work unit 10-B5: gates dev-only entitlement grant/revoke routes. */
  devToolsEnabled: boolean;
}

export interface AuthConfig {
  /** Signing secret for short-lived access tokens. Never logged. */
  jwtAccessSecret: string;
  /** Signing secret for the (separately, DB-hashed) refresh token. Never logged. */
  jwtRefreshSecret: string;
  /**
   * Phase 12, work unit 12A-B3: DEDICATED HMAC key used to hash client IP
   * addresses before they are persisted to `AuthAuditEvent.ipHash` (see
   * `AuthAuditService`). Deliberately a separate secret from
   * `jwtAccessSecret`/`jwtRefreshSecret` (DECISIONS.md "Phase 12 ...
   * approved..." entry, decision 6: "a dedicated secret, distinct from the
   * JWT/refresh-token signing secrets") so that rotating one never silently
   * changes the other's blast radius. Never logged.
   *
   * Phase 12, work unit 12B-B2 update: this SAME field is now ALSO used
   * (via the shared `hashIp` helper in `src/auth/auth-crypto.ts`) to hash
   * client IPs for `Session.ipHash` — it already satisfies decision 6's
   * "dedicated secret" requirement for that column too, so no second env
   * var was introduced for it (see `.env.example`).
   */
  authAuditIpHashSecret: string;
}

/**
 * Phase 11, work unit 11G-3: which storage backend the app is configured
 * for. `local` is the default (unset/empty `STORAGE_DRIVER` resolves to
 * `local`) and preserves today's existing behavior byte-for-byte — nothing
 * in this slice changes what `StorageService`/`StorageModule` actually do
 * with this value; wiring real R2 usage behind `driver === 'r2'` is a
 * separate, later, human-gated unit. `r2` is only meaningful once
 * `env.validation.ts` has confirmed (name-presence only, never value) that
 * every `OBJECT_STORAGE_*` variable required by `StorageService` is set.
 */
export type StorageDriver = 'local' | 'r2';

export const STORAGE_DRIVERS: readonly StorageDriver[] = ['local', 'r2'];

export const DEFAULT_STORAGE_DRIVER: StorageDriver = 'local';

/**
 * Phase 11, work unit 11A-1: provider-agnostic S3-compatible object storage
 * config, read by `StorageModule`/`StorageService`. Named generically
 * (`OBJECT_STORAGE_*`, not `R2_*`) because the service itself is
 * provider-agnostic even though Cloudflare R2 is the approved target
 * provider (see DECISIONS.md "Phase 11 (Production Media Storage...)
 * approved..." entry). Real credentials are a human action deferred to
 * 11A-3, out of scope here.
 *
 * Phase 11, work unit 11G-3 update: `OBJECT_STORAGE_*` variable NAMES are
 * now required by `env.validation.ts`, but ONLY when `STORAGE_DRIVER=r2`
 * (see `driver` below); in the default `local` mode they remain fully
 * optional, exactly as before this unit.
 *
 * Phase 11, work unit 11H-B1 update: `publicBaseUrl` is `string | undefined`
 * (not `string`), and the factory below no longer falls back to `?? ''`.
 * This is deliberate: `OBJECT_STORAGE_PUBLIC_BASE_URL` is optional even in
 * `r2` mode (see `env.validation.ts`'s `REQUIRED_R2_KEYS`), and an empty
 * string is a worse failure mode than a missing one — `''` would let
 * `StorageService.buildPublicUrl` silently assemble `"/videos/abc.mp4"`,
 * which *looks* like a valid relative path. `undefined` instead forces
 * `buildPublicUrl` to throw a clear configuration error (see its doc
 * comment in `storage.service.ts`) rather than ever returning a bogus URL.
 */
export interface StorageConfig {
  driver: StorageDriver;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string | undefined;
}

/**
 * Slice 11N — HLS Processing Data Model + Queue Foundation (control
 * workspace DECISIONS.md "2026-08-10 — Slice 11N APPROVED..." entry).
 * `enabled` mirrors `RetentionScheduleConfig.enabled`'s existing
 * **fail-closed, exact-string** shape exactly (`resolveRetentionScheduleConfig`
 * in `../retention/retention-schedule.config.ts`): `TRANSCODE_ENABLED` must
 * be the literal string `"true"` to activate anything — absent, empty,
 * `"TRUE"`, `"1"`, `"yes"`, or any other value all resolve to `false`, never
 * the reverse. `false` is this slice's only shipped state (2026-08-10
 * approval, prohibition list: "no `TRANSCODE_ENABLED=true` anywhere").
 *
 * `redisUrl` is read unconditionally by this factory (mirroring every other
 * field here — `configuration.ts` never itself decides what is
 * required/optional, `env.validation.ts` does), but is REQUIRED (by
 * `env.validation.ts`'s `validateTranscodeConfig`) only when `enabled` is
 * `true`. While `enabled` is `false`, nothing in this codebase ever reads
 * `redisUrl` — its absence, or an unreachable value, is completely
 * harmless. Never logged anywhere (see `TranscodeReadinessService`, which
 * reports presence only, never the value).
 */
/**
 * Slice 11P — Production Transcoding Lifecycle (control workspace
 * DECISIONS.md "2026-08-10 — Slice 11P APPROVED..." entry). Three additional
 * tunables, all resolved unconditionally by this factory (mirroring
 * `redisUrl`'s existing "read unconditionally, `env.validation.ts` decides
 * what's required" split) but only ever consulted by code that itself is
 * behind `TRANSCODE_ENABLED` — while the flag is `false` (this repo's only
 * shipped state), none of these three values affects anything.
 *
 * Each has a documented, sane default (`DEFAULT_TRANSCODE_MAX_ATTEMPTS`,
 * `DEFAULT_TRANSCODE_STALLED_AFTER_MINUTES`,
 * `DEFAULT_TRANSCODE_CLEANUP_GRACE_MINUTES` below) and is OPTIONAL even when
 * the flag is on — unlike `REDIS_URL`, an admin does not need to set any of
 * these three just to turn transcoding on. `env.validation.ts`'s
 * `validateTranscodeConfig` additionally fails boot loudly (only when the
 * flag is `"true"`) if a PRESENT value for one of these three is not a valid
 * positive integer — matching the 11G-3 conditional-validation pattern.
 */
export interface TranscodeConfig {
  enabled: boolean;
  redisUrl: string | undefined;
  /** Hard cap on processing attempts per generation before a job gives up permanently (`failed`, `MAX_ATTEMPTS_EXCEEDED`). */
  maxAttempts: number;
  /** How long a row may sit in `processingState = "running"` before `TranscodeJanitorService` treats it as stalled and CAS-fails it (`STALE`). */
  stalledAfterMinutes: number;
  /**
   * How long an orphaned/superseded HLS staging prefix must sit untouched
   * before `TranscodeJanitorService` deletes it. Deliberately LONGER than
   * the 30-60 minute playback-token TTL design target for the future 11Q
   * gateway (proposal §9, decision 8) — see
   * `TranscodeJanitorService`'s doc comment — so a generation a mobile client
   * may still hold a live authorization token for is never deleted out from
   * under it, even though this slice never issues such a token itself.
   */
  cleanupGraceMinutes: number;
}

/** Slice 11P default for `TranscodeConfig.maxAttempts` (proposal §8: "3 attempts"). */
export const DEFAULT_TRANSCODE_MAX_ATTEMPTS = 3;

/** Slice 11P default for `TranscodeConfig.stalledAfterMinutes`. */
export const DEFAULT_TRANSCODE_STALLED_AFTER_MINUTES = 30;

/**
 * Slice 11P default for `TranscodeConfig.cleanupGraceMinutes` — explicitly
 * longer than the 30-60 minute playback-token TTL design target
 * (proposal §9, decision 8) so a generation a viewer may still be mid-playback
 * on is never grace-deleted out from under them once that future gateway
 * ships.
 */
export const DEFAULT_TRANSCODE_CLEANUP_GRACE_MINUTES = 120;

export interface RootConfig {
  app: AppConfig;
  auth: AuthConfig;
  storage: StorageConfig;
  transcode: TranscodeConfig;
}

export default (): RootConfig => ({
  app: {
    port: parseInt(process.env.PORT ?? '3000', 10),
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
    storageRoot: process.env.STORAGE_ROOT ?? '',
    corsOrigins: (process.env.CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    devToolsEnabled: process.env.DEV_TOOLS_ENABLED === 'true',
  },
  auth: {
    jwtAccessSecret: process.env.JWT_ACCESS_SECRET ?? '',
    jwtRefreshSecret: process.env.JWT_REFRESH_SECRET ?? '',
    authAuditIpHashSecret: process.env.AUTH_AUDIT_IP_HASH_SECRET ?? '',
  },
  storage: {
    driver: resolveStorageDriver(),
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? '',
    region: process.env.OBJECT_STORAGE_REGION ?? 'auto',
    bucket: process.env.OBJECT_STORAGE_BUCKET ?? '',
    accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY ?? '',
    publicBaseUrl: process.env.OBJECT_STORAGE_PUBLIC_BASE_URL,
  },
  transcode: {
    enabled: process.env.TRANSCODE_ENABLED === 'true',
    redisUrl: process.env.REDIS_URL,
    maxAttempts: parsePositiveIntEnv(
      process.env.TRANSCODE_MAX_ATTEMPTS,
      DEFAULT_TRANSCODE_MAX_ATTEMPTS,
    ),
    stalledAfterMinutes: parsePositiveIntEnv(
      process.env.TRANSCODE_STALLED_AFTER_MINUTES,
      DEFAULT_TRANSCODE_STALLED_AFTER_MINUTES,
    ),
    cleanupGraceMinutes: parsePositiveIntEnv(
      process.env.TRANSCODE_CLEANUP_GRACE_MINUTES,
      DEFAULT_TRANSCODE_CLEANUP_GRACE_MINUTES,
    ),
  },
});

/**
 * Slice 11P: permissive parse — an absent/blank value falls back to
 * `fallback` silently (the common, flag-off case), and the same fallback is
 * used for a present-but-invalid value too. This factory is deliberately NOT
 * where an invalid value fails boot — `env.validation.ts`'s
 * `validateTranscodeConfig` is (and only when `TRANSCODE_ENABLED=true`),
 * matching `resolveStorageDriver`'s existing "validate elsewhere, resolve
 * permissively here" split immediately below.
 */
function parsePositiveIntEnv(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Phase 11, work unit 11G-3: resolves `STORAGE_DRIVER` unset/empty/`local`
 * to `local` (the default). `env.validation.ts` runs before this factory
 * (see `ConfigModule.forRoot`'s `validate` option in `app.module.ts`) and
 * already fails the app's boot for any value other than `local`/`r2`, so by
 * the time this runs the only other possible value is the literal `r2`.
 */
function resolveStorageDriver(): StorageDriver {
  return process.env.STORAGE_DRIVER === 'r2' ? 'r2' : DEFAULT_STORAGE_DRIVER;
}
