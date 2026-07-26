import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, statSync } from 'fs';
import { RootConfig, StorageConfig } from '../config/configuration';
import { StorageReadinessResponse } from './storage-readiness.types';

/**
 * Phase 11, work unit 11G-4: computes the secret-free storage-readiness
 * payload surfaced on `/health/details`. This service NEVER makes a
 * network call and NEVER returns a secret, endpoint, bucket name, region,
 * access key, or absolute path — only the active driver enum string and two
 * booleans (see `storage-readiness.types.ts`).
 *
 * `r2` mode intentionally does NOT probe R2 live: `ready` there is defined
 * as equal to `configPresent` (are the required `OBJECT_STORAGE_*` variable
 * NAMES set?), matching the same six names `env.validation.ts`'s
 * `REQUIRED_R2_KEYS` already requires at boot. A live network/R2 round-trip
 * belongs to the separate, human-gated disposable-object smoke test (see
 * `src/storage/storage-r2-smoke.spec.ts` for the unrelated, opt-in real-R2
 * test — this service is never involved in that path), not a request-time
 * health check, so `/health/details` stays fast and entirely
 * credential-free. This service's own e2e coverage lives in
 * `test/health.e2e-spec.ts`.
 */
@Injectable()
export class StorageReadinessService {
  constructor(private readonly configService: ConfigService<RootConfig>) {}

  check(): StorageReadinessResponse {
    const appConfig = this.configService.get('app', { infer: true })!;
    const storageConfig = this.configService.get('storage', { infer: true })!;

    return storageConfig.driver === 'r2'
      ? checkR2Readiness(storageConfig)
      : checkLocalReadiness(appConfig.storageRoot);
  }
}

function checkLocalReadiness(storageRoot: string): StorageReadinessResponse {
  const configPresent = storageRoot.trim().length > 0;

  return {
    driver: 'local',
    configPresent,
    ready: configPresent && isReadableDirectory(storageRoot),
  };
}

function checkR2Readiness(
  storageConfig: StorageConfig,
): StorageReadinessResponse {
  const configPresent = [
    storageConfig.endpoint,
    storageConfig.region,
    storageConfig.bucket,
    storageConfig.accessKeyId,
    storageConfig.secretAccessKey,
    storageConfig.publicBaseUrl,
  ].every((value) => value.trim().length > 0);

  return { driver: 'r2', configPresent, ready: configPresent };
}

/** A local `fs.stat` only — never touches the network. */
function isReadableDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
