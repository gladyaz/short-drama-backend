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
 * as equal to `configPresent` (are all six `OBJECT_STORAGE_*` fields on
 * `StorageConfig` set?) — this predates, and is DELIBERATELY UNCHANGED by,
 * Phase 11, work unit 11H-B1, which removed `OBJECT_STORAGE_PUBLIC_BASE_URL`
 * from `env.validation.ts`'s `REQUIRED_R2_KEYS` (now five names) so a
 * private-R2 deployment can boot without it. This service was NOT part of
 * 11H-B1's approved scope, so it still requires all six names, including
 * `publicBaseUrl`, for `configPresent`/`ready` — meaning a booted private-R2
 * deployment (the five `REQUIRED_R2_KEYS` names set, `publicBaseUrl`
 * intentionally absent) will report `ready: false` here. Whether that
 * should change is an open, separate product decision, not resolved by this
 * comment. A live network/R2 round-trip belongs to the separate,
 * human-gated disposable-object smoke test (see
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
    // Phase 11, work unit 11H-B1: `publicBaseUrl` became `string | undefined`
    // (it is now optional even at boot — see `env.validation.ts`'s
    // `REQUIRED_R2_KEYS`, which no longer includes it). This `?? ''`
    // deliberately PRESERVES this service's pre-11H-B1 behavior byte for
    // byte (an absent public base URL still makes `configPresent`/`ready`
    // false here) rather than silently loosening what "ready" means —
    // 11H-B1's approved scope covers boot validation and
    // `StorageService.buildPublicUrl` only, not this readiness signal.
    // Whether a private-R2 deployment (5 names set, this one intentionally
    // absent) should report `ready: true` here is a real, separate product
    // question, deliberately left open rather than decided in this slice.
    storageConfig.publicBaseUrl ?? '',
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
