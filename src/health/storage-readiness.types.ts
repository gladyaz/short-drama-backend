import { StorageDriver } from '../config/configuration';

/**
 * Phase 11, work unit 11G-4: secret-free storage-readiness payload for
 * `/health/details`. Booleans + the active driver name ONLY — this type is
 * deliberately narrow so nothing else (endpoint, bucket, region, access
 * key, secret, or any absolute `STORAGE_ROOT` path) can ever be added to it
 * without a visible shape change here.
 */
export interface StorageReadinessResponse {
  /** The active `STORAGE_DRIVER` value. Not a secret. */
  driver: StorageDriver;
  /**
   * `local`: `STORAGE_ROOT` exists and is a readable directory (a local
   * `fs.stat`, never a network call).
   * `r2`: always equal to `configPresent` — no live network/R2 probe is
   * made from this endpoint, so readiness in `r2` mode reflects config-name
   * presence only.
   */
  ready: boolean;
  /**
   * Whether the required config variable NAMES for the active driver are
   * all set. `local` → `STORAGE_ROOT` set. `r2` → all six
   * `OBJECT_STORAGE_*` fields on `StorageConfig` (NOT the same set as
   * `env.validation.ts`'s `REQUIRED_R2_KEYS`, which is five names as of
   * Phase 11, work unit 11H-B1 — `OBJECT_STORAGE_PUBLIC_BASE_URL` is
   * optional for boot but still checked here; see the doc comment on
   * `checkR2Readiness` in `storage-readiness.service.ts`). Presence only —
   * never a value.
   */
  configPresent: boolean;
}
