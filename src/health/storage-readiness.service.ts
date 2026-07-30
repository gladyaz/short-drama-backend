import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, statSync } from 'fs';
import { RootConfig, StorageConfig } from '../config/configuration';
import { REQUIRED_R2_KEYS } from '../config/env.validation';
import { StorageReadinessResponse } from './storage-readiness.types';

/**
 * Phase 11, work unit 11G-4: computes the secret-free storage-readiness
 * payload surfaced on `/health/details`. This service NEVER makes a
 * network call and NEVER returns a secret, endpoint, bucket name, region,
 * access key, or absolute path — only the active driver enum string and
 * booleans (see `storage-readiness.types.ts`).
 *
 * `r2` mode intentionally does NOT probe R2 live: `ready` there is defined
 * as equal to `configPresent`, which asks one question only — is every
 * `OBJECT_STORAGE_*` variable NAME in `env.validation.ts`'s canonical
 * `REQUIRED_R2_KEYS` set? A live network/R2 round-trip belongs to the
 * separate, human-gated disposable-object smoke test (see
 * `src/storage/storage-r2-smoke.spec.ts` for the unrelated, opt-in real-R2
 * test — this service is never involved in that path), not a request-time
 * health check, so `/health/details` stays fast and entirely
 * credential-free. This service's own e2e coverage lives in
 * `test/health.e2e-spec.ts`.
 *
 * Phase 11, work unit 11I-B1: this service used to hard-code a SIX-name R2
 * requirement list of its own. Work unit 11H-B1 then reduced
 * `REQUIRED_R2_KEYS` to FIVE names (dropping
 * `OBJECT_STORAGE_PUBLIC_BASE_URL`) so a private R2 bucket could boot, and
 * the two lists silently diverged: a correctly configured private
 * deployment — presigned PUT/HEAD/GET/DELETE all working — reported
 * `ready: false` forever, making the endpoint useless as a deploy gate or
 * monitoring signal. Readiness now derives from `REQUIRED_R2_KEYS`
 * directly, so there is no second list left to drift. Public delivery is
 * reported as its own explicit `publicDeliveryAvailable` boolean instead of
 * being smuggled into readiness.
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
    // No `publicDeliveryAvailable` key at all in `local` mode — see the
    // field's doc comment in `storage-readiness.types.ts` for why "absent"
    // (not applicable) beats a hard-coded `false` here.
  };
}

/**
 * Every `StorageConfig` field that holds a configured VALUE — i.e.
 * everything except the `driver` enum, which is not an `OBJECT_STORAGE_*`
 * variable and must never be mistaken for one.
 */
type R2ConfigField = Exclude<keyof StorageConfig, 'driver'>;

/**
 * Phase 11, work unit 11I-B1: the explicit bridge between the canonical
 * env-var NAMES in `REQUIRED_R2_KEYS` (what boot validation checks, since
 * it only ever sees `process.env`) and the `StorageConfig` FIELDS this
 * service sees (what `configuration.ts` already parsed those names into).
 * It maps names to field names only — no value is ever read here.
 *
 * This is a `Record` keyed by the `REQUIRED_R2_KEYS` union on purpose: it
 * makes the drift that caused this work unit impossible to reintroduce
 * silently. Adding a name to `REQUIRED_R2_KEYS` fails compilation until it
 * is mapped here (and readiness then requires it automatically); removing
 * one fails compilation on the now-excess entry. There is no second list to
 * keep in sync — only this mapping, which cannot be incomplete.
 */
const R2_CONFIG_FIELD_BY_REQUIRED_ENV_VAR: Record<
  (typeof REQUIRED_R2_KEYS)[number],
  R2ConfigField
> = {
  OBJECT_STORAGE_ENDPOINT: 'endpoint',
  OBJECT_STORAGE_REGION: 'region',
  OBJECT_STORAGE_BUCKET: 'bucket',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'accessKeyId',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'secretAccessKey',
};

function checkR2Readiness(
  storageConfig: StorageConfig,
): StorageReadinessResponse {
  const configPresent = REQUIRED_R2_KEYS.every((requiredEnvVar) =>
    isConfigured(
      storageConfig[R2_CONFIG_FIELD_BY_REQUIRED_ENV_VAR[requiredEnvVar]],
    ),
  );

  return {
    driver: 'r2',
    configPresent,
    ready: configPresent,
    // `OBJECT_STORAGE_PUBLIC_BASE_URL` is NOT part of readiness (it is not
    // in `REQUIRED_R2_KEYS`, and `createPresignedPutUrl`/
    // `createPresignedGetUrl`/`headObject`/`objectExists`/`deleteObject`/
    // `putObject` never touch it). It answers a different question, so it
    // gets its own field.
    publicDeliveryAvailable: isConfigured(storageConfig.publicBaseUrl),
  };
}

/**
 * Presence only. Never compares, parses, logs, or returns the value itself
 * — a whitespace-only value counts as absent, matching the `trim()`
 * semantics used everywhere else in this file.
 */
function isConfigured(value: string | undefined): boolean {
  return (value ?? '').trim().length > 0;
}

/** A local `fs.stat` only — never touches the network. */
function isReadableDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
