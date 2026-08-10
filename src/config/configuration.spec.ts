import configuration, { DEFAULT_STORAGE_DRIVER } from './configuration';

/**
 * Phase 11, work unit 11G-3: unit coverage for the `STORAGE_DRIVER`
 * resolution added to the config factory. Entirely in-memory — sets/restores
 * `process.env.STORAGE_DRIVER` around each test, makes no network call, and
 * never touches real credentials.
 */
describe('configuration — storage.driver (Phase 11, 11G-3)', () => {
  const originalStorageDriver = process.env.STORAGE_DRIVER;

  afterEach(() => {
    if (originalStorageDriver === undefined) {
      delete process.env.STORAGE_DRIVER;
    } else {
      process.env.STORAGE_DRIVER = originalStorageDriver;
    }
  });

  it('resolves storage.driver to "local" (the default) when STORAGE_DRIVER is unset', () => {
    delete process.env.STORAGE_DRIVER;

    expect(configuration().storage.driver).toBe(DEFAULT_STORAGE_DRIVER);
    expect(configuration().storage.driver).toBe('local');
  });

  it('resolves storage.driver to "local" when STORAGE_DRIVER is empty', () => {
    process.env.STORAGE_DRIVER = '';

    expect(configuration().storage.driver).toBe('local');
  });

  it('resolves storage.driver to "r2" when STORAGE_DRIVER=r2', () => {
    process.env.STORAGE_DRIVER = 'r2';

    expect(configuration().storage.driver).toBe('r2');
  });
});

/**
 * Slice 11N, proof 3: `TRANSCODE_ENABLED` defaults false — absent or
 * anything other than the EXACT string `"true"` resolves to `false`.
 * Entirely in-memory, mirroring `STORAGE_DRIVER`'s spec above.
 */
describe('configuration — transcode.enabled (Slice 11N)', () => {
  const originalTranscodeEnabled = process.env.TRANSCODE_ENABLED;
  const originalRedisUrl = process.env.REDIS_URL;

  afterEach(() => {
    if (originalTranscodeEnabled === undefined) {
      delete process.env.TRANSCODE_ENABLED;
    } else {
      process.env.TRANSCODE_ENABLED = originalTranscodeEnabled;
    }
    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = originalRedisUrl;
    }
  });

  it('resolves to false when TRANSCODE_ENABLED is unset', () => {
    delete process.env.TRANSCODE_ENABLED;

    expect(configuration().transcode.enabled).toBe(false);
  });

  it.each(['', 'TRUE', 'True', '1', 'yes', 'false', 'garbage'])(
    'resolves to false when TRANSCODE_ENABLED=%s (only the exact string "true" enables it)',
    (value) => {
      process.env.TRANSCODE_ENABLED = value;

      expect(configuration().transcode.enabled).toBe(false);
    },
  );

  it('resolves to true only when TRANSCODE_ENABLED is exactly "true"', () => {
    process.env.TRANSCODE_ENABLED = 'true';

    expect(configuration().transcode.enabled).toBe(true);
  });

  it('redisUrl is undefined when REDIS_URL is unset, regardless of the flag', () => {
    delete process.env.REDIS_URL;

    expect(configuration().transcode.redisUrl).toBeUndefined();
  });

  it('redisUrl reflects REDIS_URL verbatim when set', () => {
    process.env.REDIS_URL = 'redis://example.invalid:6379';

    expect(configuration().transcode.redisUrl).toBe(
      'redis://example.invalid:6379',
    );
  });
});

/**
 * Slice 11P — the three optional numeric tunables added to `TranscodeConfig`.
 * Entirely in-memory, mirroring the spec above.
 */
describe('configuration — transcode.maxAttempts / stalledAfterMinutes / cleanupGraceMinutes (Slice 11P)', () => {
  const KEYS = [
    'TRANSCODE_MAX_ATTEMPTS',
    'TRANSCODE_STALLED_AFTER_MINUTES',
    'TRANSCODE_CLEANUP_GRACE_MINUTES',
  ] as const;
  const originalValues = KEYS.map((key) => process.env[key]);

  afterEach(() => {
    KEYS.forEach((key, index) => {
      const original = originalValues[index];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    });
  });

  it('resolves every default when all three are unset', () => {
    KEYS.forEach((key) => delete process.env[key]);

    const transcode = configuration().transcode;
    expect(transcode.maxAttempts).toBe(3);
    expect(transcode.stalledAfterMinutes).toBe(30);
    expect(transcode.cleanupGraceMinutes).toBe(120);
  });

  it('reflects a valid positive-integer override for each field', () => {
    process.env.TRANSCODE_MAX_ATTEMPTS = '5';
    process.env.TRANSCODE_STALLED_AFTER_MINUTES = '45';
    process.env.TRANSCODE_CLEANUP_GRACE_MINUTES = '240';

    const transcode = configuration().transcode;
    expect(transcode.maxAttempts).toBe(5);
    expect(transcode.stalledAfterMinutes).toBe(45);
    expect(transcode.cleanupGraceMinutes).toBe(240);
  });

  it.each(['0', '-1', 'garbage', '2.5', ''])(
    'falls back to the default for an invalid value (%s) rather than throwing',
    (value) => {
      process.env.TRANSCODE_MAX_ATTEMPTS = value;

      expect(configuration().transcode.maxAttempts).toBe(3);
    },
  );
});
