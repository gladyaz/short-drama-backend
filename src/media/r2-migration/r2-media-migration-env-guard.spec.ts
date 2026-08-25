import {
  R2_MIGRATION_APPLY_BUCKET_ENV,
  assertMigrationApplyAllowed,
} from './r2-media-migration-env-guard';

/**
 * Work unit "R2 MEDIA MIGRATION": the gate every WRITING run must pass. Pure
 * function — takes its inputs as arguments, so these tests read no
 * environment and touch no bucket.
 */
describe('assertMigrationApplyAllowed', () => {
  const VALID = {
    configuredBucket: 'short-drama-media-prod',
    restatedBucket: 'short-drama-media-prod',
    storageDriver: 'r2',
  };

  it('permits a run whose restated bucket matches under the r2 driver', () => {
    expect(() => assertMigrationApplyAllowed(VALID)).not.toThrow();
  });

  it('refuses under the local driver, before any file is read', () => {
    expect(() =>
      assertMigrationApplyAllowed({ ...VALID, storageDriver: 'local' }),
    ).toThrow(/STORAGE_DRIVER is "local", not "r2"/);
  });

  it('refuses when no bucket is configured', () => {
    expect(() =>
      assertMigrationApplyAllowed({ ...VALID, configuredBucket: '' }),
    ).toThrow(/OBJECT_STORAGE_BUCKET is not set/);
  });

  it('refuses when the operator has not restated the bucket, and names the variable', () => {
    expect(() =>
      assertMigrationApplyAllowed({ ...VALID, restatedBucket: undefined }),
    ).toThrow(new RegExp(`${R2_MIGRATION_APPLY_BUCKET_ENV} is not set`));
  });

  it('refuses a MISMATCHED restatement — the case that stops a wrong-bucket write', () => {
    expect(() =>
      assertMigrationApplyAllowed({
        ...VALID,
        restatedBucket: 'short-drama-media-dev',
      }),
    ).toThrow(/does not match OBJECT_STORAGE_BUCKET/);
  });

  it('names both buckets on a mismatch so the error is actionable', () => {
    expect(() =>
      assertMigrationApplyAllowed({
        ...VALID,
        restatedBucket: 'short-drama-media-dev',
      }),
    ).toThrow(/short-drama-media-dev[\s\S]*short-drama-media-prod/);
  });
});
