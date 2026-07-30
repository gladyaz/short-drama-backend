import { StorageDriver } from '../config/configuration';

/**
 * Phase 11, work unit 11G-4: secret-free storage-readiness payload for
 * `/health/details`. Booleans + the active driver name ONLY — this type is
 * deliberately narrow so nothing else (endpoint, bucket, region, access
 * key, secret, or any absolute `STORAGE_ROOT` path) can ever be added to it
 * without a visible shape change here.
 *
 * Phase 11, work unit 11I-B1 update: `publicDeliveryAvailable` added, and
 * `configPresent`'s `r2` definition now derives from the single canonical
 * requirement list (`env.validation.ts`'s `REQUIRED_R2_KEYS`) instead of a
 * duplicated one — see `storage-readiness.service.ts`.
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
   * all set. `local` → `STORAGE_ROOT` set. `r2` → every name in
   * `env.validation.ts`'s `REQUIRED_R2_KEYS`, the SAME canonical list boot
   * validation uses (imported, never re-listed — Phase 11, work unit
   * 11I-B1). Presence only — never a value.
   */
  configPresent: boolean;
  /**
   * Phase 11, work unit 11I-B1. Whether `OBJECT_STORAGE_PUBLIC_BASE_URL` is
   * configured — i.e. whether this deployment can hand out PUBLIC
   * (non-presigned) object URLs via `StorageService.buildPublicUrl`.
   * `false` when it is absent, empty, or whitespace-only; `true` when it
   * holds a value. Presence only — the URL itself never appears here.
   *
   * Deliberately INDEPENDENT of `ready`/`configPresent`: a private R2
   * bucket (no public access, no `r2.dev`, no custom domain) delivers media
   * exclusively through presigned PUT/GET and is fully ready with this
   * `false`. Treating an absent public base URL as a readiness failure is
   * exactly the defect 11I-B1 fixes.
   *
   * OMITTED ENTIRELY in `local` mode (hence optional), rather than reported
   * as `false`. Public object-storage delivery is not a concept that exists
   * for the `local` driver: nothing reads `OBJECT_STORAGE_PUBLIC_BASE_URL`
   * there, and the app serves bytes itself through its own authenticated
   * route. Omitting the key leaves the `local` payload byte-for-byte
   * identical to its pre-11I-B1 shape, so no existing local consumer sees
   * any change at all, whereas a hard-coded `false` would read as a
   * degraded capability on a perfectly healthy local deployment. That is a
   * payload-stability and honesty argument, NOT an alerting one: a consumer
   * written as `if (!storage.publicDeliveryAvailable)` cannot distinguish
   * absent from `false` — only a strict `=== false` check can. A `true` —
   * because a stale `OBJECT_STORAGE_PUBLIC_BASE_URL` is still sitting in
   * someone's `.env` — would be an outright false claim about a driver that
   * cannot do public delivery at all. Absent means "not
   * applicable to this driver", which is the honest, least surprising
   * answer for an operator. Asserted explicitly in
   * `storage-readiness.service.spec.ts` and `test/health.e2e-spec.ts`.
   */
  publicDeliveryAvailable?: boolean;
}
