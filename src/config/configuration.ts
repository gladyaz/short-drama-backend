export interface AppConfig {
  port: number;
  publicBaseUrl: string;
  storageRoot: string;
  corsOrigins: string[];
}

export interface AuthConfig {
  /** Signing secret for short-lived access tokens. Never logged. */
  jwtAccessSecret: string;
  /** Signing secret for the (separately, DB-hashed) refresh token. Never logged. */
  jwtRefreshSecret: string;
}

export interface RootConfig {
  app: AppConfig;
  auth: AuthConfig;
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
  },
  auth: {
    jwtAccessSecret: process.env.JWT_ACCESS_SECRET ?? '',
    jwtRefreshSecret: process.env.JWT_REFRESH_SECRET ?? '',
  },
});
