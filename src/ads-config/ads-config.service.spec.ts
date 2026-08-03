import { Logger } from '@nestjs/common';
import { AdsConfigService } from './ads-config.service';
import { DEFAULT_ADS_CONFIG } from './ads-config.types';

/**
 * Phase 15A, slice 15A-S1: unit coverage for the `ADS_*` env-var parsing
 * and sanitization behind `GET /config/ads`. Entirely in-memory — sets and
 * restores `process.env.ADS_*` around each test (following the
 * `configuration.spec.ts` save/restore convention) and makes no network
 * call.
 */
describe('AdsConfigService', () => {
  const ENV_KEYS = [
    'ADS_INTERSTITIAL_ENABLED',
    'ADS_MIN_VIDEOS_BETWEEN_ADS',
    'ADS_MAX_VIDEOS_BETWEEN_ADS',
    'ADS_MIN_SECONDS_BETWEEN_ADS',
    'ADS_GRACE_VIDEOS',
  ] as const;

  const originalEnv = new Map<string, string | undefined>();
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    for (const [key, value] of originalEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    warnSpy.mockRestore();
  });

  describe('defaults (all five env vars unset)', () => {
    it('returns the frozen-contract default config with no warnings', () => {
      const service = new AdsConfigService();

      expect(service.getConfig()).toEqual(DEFAULT_ADS_CONFIG);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('ADS_INTERSTITIAL_ENABLED', () => {
    it('is true when unset (no warning)', () => {
      delete process.env.ADS_INTERSTITIAL_ENABLED;

      expect(new AdsConfigService().getConfig().enabled).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('is false when set to "false" (no warning)', () => {
      process.env.ADS_INTERSTITIAL_ENABLED = 'false';

      expect(new AdsConfigService().getConfig().enabled).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('is true when set to "true" (no warning)', () => {
      process.env.ADS_INTERSTITIAL_ENABLED = 'true';

      expect(new AdsConfigService().getConfig().enabled).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('is true and warns when set to an unrecognized value', () => {
      process.env.ADS_INTERSTITIAL_ENABLED = 'yes';

      expect(new AdsConfigService().getConfig().enabled).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('ADS_INTERSTITIAL_ENABLED'),
      );
    });
  });

  describe('ADS_MIN_VIDEOS_BETWEEN_ADS / ADS_MAX_VIDEOS_BETWEEN_ADS', () => {
    it('respects valid overrides for both fields', () => {
      process.env.ADS_MIN_VIDEOS_BETWEEN_ADS = '2';
      process.env.ADS_MAX_VIDEOS_BETWEEN_ADS = '8';

      const config = new AdsConfigService().getConfig();

      expect(config.minVideosBetweenAds).toBe(2);
      expect(config.maxVideosBetweenAds).toBe(8);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('falls back min to default + warns on a non-numeric value', () => {
      process.env.ADS_MIN_VIDEOS_BETWEEN_ADS = 'not-a-number';

      const config = new AdsConfigService().getConfig();

      expect(config.minVideosBetweenAds).toBe(
        DEFAULT_ADS_CONFIG.minVideosBetweenAds,
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('ADS_MIN_VIDEOS_BETWEEN_ADS'),
      );
    });

    it('falls back max to default + warns on a negative value', () => {
      process.env.ADS_MAX_VIDEOS_BETWEEN_ADS = '-1';

      const config = new AdsConfigService().getConfig();

      expect(config.maxVideosBetweenAds).toBe(
        DEFAULT_ADS_CONFIG.maxVideosBetweenAds,
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('ADS_MAX_VIDEOS_BETWEEN_ADS'),
      );
    });

    it('reverts BOTH min and max to defaults + warns when min > max after parsing', () => {
      process.env.ADS_MIN_VIDEOS_BETWEEN_ADS = '10';
      process.env.ADS_MAX_VIDEOS_BETWEEN_ADS = '2';

      const config = new AdsConfigService().getConfig();

      expect(config.minVideosBetweenAds).toBe(
        DEFAULT_ADS_CONFIG.minVideosBetweenAds,
      );
      expect(config.maxVideosBetweenAds).toBe(
        DEFAULT_ADS_CONFIG.maxVideosBetweenAds,
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('ADS_MIN_VIDEOS_BETWEEN_ADS'),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('ADS_MAX_VIDEOS_BETWEEN_ADS'),
      );
    });

    it('reverts both to defaults when min > max even though each individually parsed validly', () => {
      // Neither field is independently invalid — the reversal is driven
      // purely by the min > max comparison, not by per-field validation.
      process.env.ADS_MIN_VIDEOS_BETWEEN_ADS = '7';
      process.env.ADS_MAX_VIDEOS_BETWEEN_ADS = '5';

      const config = new AdsConfigService().getConfig();

      expect(config.minVideosBetweenAds).toBe(
        DEFAULT_ADS_CONFIG.minVideosBetweenAds,
      );
      expect(config.maxVideosBetweenAds).toBe(
        DEFAULT_ADS_CONFIG.maxVideosBetweenAds,
      );
    });
  });

  describe('ADS_MIN_SECONDS_BETWEEN_ADS', () => {
    it('respects a valid override', () => {
      process.env.ADS_MIN_SECONDS_BETWEEN_ADS = '45';

      expect(new AdsConfigService().getConfig().minSecondsBetweenAds).toBe(45);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('falls back to default + warns on a non-numeric value', () => {
      process.env.ADS_MIN_SECONDS_BETWEEN_ADS = 'abc';

      const config = new AdsConfigService().getConfig();

      expect(config.minSecondsBetweenAds).toBe(
        DEFAULT_ADS_CONFIG.minSecondsBetweenAds,
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('ADS_MIN_SECONDS_BETWEEN_ADS'),
      );
    });

    it('falls back to default + warns on a negative value', () => {
      process.env.ADS_MIN_SECONDS_BETWEEN_ADS = '-10';

      const config = new AdsConfigService().getConfig();

      expect(config.minSecondsBetweenAds).toBe(
        DEFAULT_ADS_CONFIG.minSecondsBetweenAds,
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('ADS_MIN_SECONDS_BETWEEN_ADS'),
      );
    });
  });

  describe('ADS_GRACE_VIDEOS', () => {
    it('respects a valid override', () => {
      process.env.ADS_GRACE_VIDEOS = '10';

      expect(new AdsConfigService().getConfig().graceVideos).toBe(10);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('falls back to default + warns on a non-numeric value', () => {
      process.env.ADS_GRACE_VIDEOS = 'nope';

      const config = new AdsConfigService().getConfig();

      expect(config.graceVideos).toBe(DEFAULT_ADS_CONFIG.graceVideos);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('ADS_GRACE_VIDEOS'),
      );
    });

    it('falls back to default + warns on a negative value', () => {
      process.env.ADS_GRACE_VIDEOS = '-5';

      const config = new AdsConfigService().getConfig();

      expect(config.graceVideos).toBe(DEFAULT_ADS_CONFIG.graceVideos);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('ADS_GRACE_VIDEOS'),
      );
    });

    it('treats a blank string the same as unset (default, no warning)', () => {
      process.env.ADS_GRACE_VIDEOS = '   ';

      const config = new AdsConfigService().getConfig();

      expect(config.graceVideos).toBe(DEFAULT_ADS_CONFIG.graceVideos);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  it('reads env vars once at construction — later mutation does not affect an existing instance', () => {
    const service = new AdsConfigService();
    process.env.ADS_GRACE_VIDEOS = '999';

    expect(service.getConfig().graceVideos).toBe(
      DEFAULT_ADS_CONFIG.graceVideos,
    );
  });
});
