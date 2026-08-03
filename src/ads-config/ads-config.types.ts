/**
 * Phase 15A, slice 15A-S1 (control workspace `DECISIONS.md`, entry
 * "2026-08-03 — Phase 15A slice S1 APPROVED...", commit `0f75033`).
 *
 * This exact five-field shape is a FROZEN CONTRACT shared with the mobile
 * app's pure ad-gating logic (`mobile-app-ecc/src/services/ads/ad-gate.ts`'s
 * `AdsConfig`). Field names, types, and defaults must match that contract
 * byte-for-byte — do not add, remove, or rename a field here without a
 * corresponding recorded decision and a matching mobile-side change.
 */
export interface AdsConfig {
  enabled: boolean;
  minVideosBetweenAds: number;
  maxVideosBetweenAds: number;
  minSecondsBetweenAds: number;
  graceVideos: number;
}

/**
 * Defaults pinned by the frozen contract: `enabled=true`, `min=3`, `max=6`,
 * `seconds=120`, `grace=5`. Used both as the fallback for an unset env var
 * and as the fallback any single field reverts to when its own env var
 * value fails validation (see `AdsConfigService`).
 */
export const DEFAULT_ADS_CONFIG: Readonly<AdsConfig> = {
  enabled: true,
  minVideosBetweenAds: 3,
  maxVideosBetweenAds: 6,
  minSecondsBetweenAds: 120,
  graceVideos: 5,
};
