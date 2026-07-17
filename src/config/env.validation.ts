import { existsSync, statSync } from 'fs';

const REQUIRED_KEYS = [
  'PORT',
  'PUBLIC_BASE_URL',
  'STORAGE_ROOT',
  'CORS_ORIGINS',
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

  return config;
}
