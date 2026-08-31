import { AppConfig, StorageConfig } from '../../config/configuration';

/**
 * Work unit "LOCAL SERIES COVER ARTWORK": a KEY-AWARE `ConfigService` double.
 *
 * WHY THIS EXISTS. The Series specs previously stubbed `ConfigService` as
 * `{ get: () => TEST_APP_CONFIG }` — one canned answer for every key. That was
 * harmless while only `configService.get('app')` was called, and became a trap
 * the moment a service also read `configService.get('storage')`: the app config
 * was returned for it, so `storage.driver` silently read `undefined`. A branch
 * on that would take whichever path `undefined` happens to fall into, and the
 * spec would be asserting the behaviour of a config shape that cannot exist.
 *
 * Returning `undefined` for an UNSTUBBED key is deliberate and is the whole
 * point: production code reads config as `configService.get('x', { infer:
 * true })!`, so an unstubbed key fails loudly at the first property access
 * instead of quietly yielding a neighbouring section's values.
 */
export function createConfigServiceMock(sections: {
  app?: Partial<AppConfig>;
  storage?: Partial<StorageConfig>;
  [key: string]: unknown;
}): { get: (key: string) => unknown } {
  return {
    get: (key: string): unknown => sections[key],
  };
}

/**
 * A complete `StorageConfig` for tests, defaulting to the `r2` driver.
 *
 * `r2` IS THE RIGHT DEFAULT HERE even though `local` is production
 * `configuration.ts`'s default, because every pre-existing Series spec was
 * written against the presigned-URL branch and asserts
 * `syntheticSignedGetUrlFor(key)`. Defaulting to `local` would silently move
 * all of them onto the local-URL branch and turn a set of passing assertions
 * into a set of assertions about a different code path. A spec that wants the
 * local branch asks for it by name.
 */
export function buildTestStorageConfig(
  overrides: Partial<StorageConfig> = {},
): StorageConfig {
  return {
    driver: 'r2',
    endpoint: '',
    region: 'auto',
    bucket: 'test-bucket',
    accessKeyId: '',
    secretAccessKey: '',
    publicBaseUrl: undefined,
    localRoot: '/tmp/local-objects.test',
    ...overrides,
  };
}
