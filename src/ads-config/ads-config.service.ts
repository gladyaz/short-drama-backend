import { Injectable, Logger } from '@nestjs/common';
import { AdsConfig, DEFAULT_ADS_CONFIG } from './ads-config.types';

/** Only non-negative-integer env vars in this contract go through this parser. */
type IntEnvVarName =
  | 'ADS_MIN_VIDEOS_BETWEEN_ADS'
  | 'ADS_MAX_VIDEOS_BETWEEN_ADS'
  | 'ADS_MIN_SECONDS_BETWEEN_ADS'
  | 'ADS_GRACE_VIDEOS';

/**
 * Phase 15A, slice 15A-S1 (control workspace `DECISIONS.md`, "2026-08-03 —
 * Phase 15A slice S1 APPROVED...", commit `0f75033`). Backs the public
 * `GET /config/ads` route (`AdsConfigController`) so the mobile app's
 * interstitial-ad frequency can be tuned server-side without an app release.
 *
 * Reads its five `ADS_*` env vars ONCE, here in the constructor (this
 * provider is a singleton, so that is once per process lifetime), sanitizes
 * each per the frozen contract, and logs a `warn` — naming the variable
 * only, never its (non-secret, but still not worth echoing) raw value — for
 * every value that fails validation and falls back to a default. This
 * mirrors the `resolveStorageDriver`/`validateStorageDriver` precedent in
 * `src/config/configuration.ts` / `src/config/env.validation.ts` for
 * feature-flag-shaped env parsing, but lives in its own service (rather than
 * being folded into the global `configuration.ts` factory) because these
 * vars are OPTIONAL, per-field-defaulting, and warn-on-invalid rather than
 * fail-to-boot — a materially different validation shape from anything
 * `env.validation.ts` already does, and one that benefits from its own
 * injectable `Logger` and independent unit-test coverage.
 *
 * No schema change, no migration, no new dependency — this is pure env-var
 * parsing.
 */
@Injectable()
export class AdsConfigService {
  private readonly logger = new Logger(AdsConfigService.name);
  private readonly config: Readonly<AdsConfig>;

  constructor() {
    this.config = this.buildConfig();
  }

  getConfig(): AdsConfig {
    return this.config;
  }

  private buildConfig(): AdsConfig {
    const enabled = this.parseEnabled();
    const minSecondsBetweenAds = this.parseNonNegativeInt(
      'ADS_MIN_SECONDS_BETWEEN_ADS',
    );
    const graceVideos = this.parseNonNegativeInt('ADS_GRACE_VIDEOS');

    const { minVideosBetweenAds, maxVideosBetweenAds } =
      this.parseVideosBetweenAdsRange();

    return {
      enabled,
      minVideosBetweenAds,
      maxVideosBetweenAds,
      minSecondsBetweenAds,
      graceVideos,
    };
  }

  /**
   * `ADS_INTERSTITIAL_ENABLED`: unset -> `true` (silent), `'false'` ->
   * `false`, `'true'` -> `true`, anything else -> `true` + `logger.warn`.
   */
  private parseEnabled(): boolean {
    const raw = process.env.ADS_INTERSTITIAL_ENABLED;

    if (raw === undefined) {
      return DEFAULT_ADS_CONFIG.enabled;
    }

    if (raw === 'false') {
      return false;
    }

    if (raw === 'true') {
      return true;
    }

    this.logger.warn(
      'ADS_INTERSTITIAL_ENABLED has an unrecognized value (expected "true" ' +
        'or "false"); defaulting to enabled=true.',
    );
    return true;
  }

  /**
   * `ADS_MIN_VIDEOS_BETWEEN_ADS` / `ADS_MAX_VIDEOS_BETWEEN_ADS`: each field
   * is first sanitized independently by `parseNonNegativeInt` (non-numeric
   * or negative -> that field's own default + warn), and only THEN, if the
   * resulting min is greater than the resulting max, BOTH revert to their
   * defaults + a single additional warn. This ordering matches the frozen
   * contract's "min > max AFTER parsing" wording exactly.
   */
  private parseVideosBetweenAdsRange(): {
    minVideosBetweenAds: number;
    maxVideosBetweenAds: number;
  } {
    const minVideosBetweenAds = this.parseNonNegativeInt(
      'ADS_MIN_VIDEOS_BETWEEN_ADS',
    );
    const maxVideosBetweenAds = this.parseNonNegativeInt(
      'ADS_MAX_VIDEOS_BETWEEN_ADS',
    );

    if (minVideosBetweenAds > maxVideosBetweenAds) {
      this.logger.warn(
        'ADS_MIN_VIDEOS_BETWEEN_ADS is greater than ' +
          'ADS_MAX_VIDEOS_BETWEEN_ADS after parsing; reverting both to ' +
          'their defaults.',
      );
      return {
        minVideosBetweenAds: DEFAULT_ADS_CONFIG.minVideosBetweenAds,
        maxVideosBetweenAds: DEFAULT_ADS_CONFIG.maxVideosBetweenAds,
      };
    }

    return { minVideosBetweenAds, maxVideosBetweenAds };
  }

  /**
   * Shared parser for the four integer-shaped `ADS_*` env vars. Unset or
   * blank -> that field's default, silently (an unset optional var is not a
   * misconfiguration). Present but non-numeric, fractional, or negative ->
   * that field's default + `logger.warn` naming the variable only.
   */
  private parseNonNegativeInt(envVarName: IntEnvVarName): number {
    const fallback = DEFAULT_ADS_CONFIG[toConfigField(envVarName)];
    const raw = process.env[envVarName];

    if (raw === undefined || raw.trim().length === 0) {
      return fallback;
    }

    const trimmed = raw.trim();
    const isNonNegativeIntegerLiteral = /^\d+$/.test(trimmed);

    if (!isNonNegativeIntegerLiteral) {
      this.logger.warn(
        `${envVarName} is not a valid non-negative integer; using the ` +
          'default value.',
      );
      return fallback;
    }

    return parseInt(trimmed, 10);
  }
}

/**
 * Maps each integer-shaped env var name to its `AdsConfig` field, so the
 * default it falls back to can never silently drift from
 * `DEFAULT_ADS_CONFIG` (adding a name here that doesn't exist on `AdsConfig`
 * fails compilation).
 */
function toConfigField(
  envVarName: IntEnvVarName,
): Exclude<keyof AdsConfig, 'enabled'> {
  const map: Record<IntEnvVarName, Exclude<keyof AdsConfig, 'enabled'>> = {
    ADS_MIN_VIDEOS_BETWEEN_ADS: 'minVideosBetweenAds',
    ADS_MAX_VIDEOS_BETWEEN_ADS: 'maxVideosBetweenAds',
    ADS_MIN_SECONDS_BETWEEN_ADS: 'minSecondsBetweenAds',
    ADS_GRACE_VIDEOS: 'graceVideos',
  };

  return map[envVarName];
}
