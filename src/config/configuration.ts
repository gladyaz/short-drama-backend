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

export interface RootConfig {
  app: AppConfig;
  auth: AuthConfig;
  storage: StorageConfig;
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
});

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
