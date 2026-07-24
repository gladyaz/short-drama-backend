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
}

/**
 * Phase 11, work unit 11A-1: provider-agnostic S3-compatible object storage
 * config, read by `StorageModule`/`StorageService`. Named generically
 * (`OBJECT_STORAGE_*`, not `R2_*`) because the service itself is
 * provider-agnostic even though Cloudflare R2 is the approved target
 * provider (see DECISIONS.md "Phase 11 (Production Media Storage...)
 * approved..." entry). Deliberately NOT added to `env.validation.ts`'s
 * `REQUIRED_KEYS`: this credential-free slice never constructs a real,
 * network-reaching client (unit tests inject a mocked client; nothing in
 * this slice wires `StorageService` up to routes that call the real AWS
 * SDK against these values) — see DECISIONS.md "Phase 11 runbook
 * reviewed..." entry. Real credentials are a human action deferred to
 * 11A-3, out of scope here.
 */
export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
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
  },
  storage: {
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? '',
    region: process.env.OBJECT_STORAGE_REGION ?? 'auto',
    bucket: process.env.OBJECT_STORAGE_BUCKET ?? '',
    accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY ?? '',
    publicBaseUrl: process.env.OBJECT_STORAGE_PUBLIC_BASE_URL ?? '',
  },
});
