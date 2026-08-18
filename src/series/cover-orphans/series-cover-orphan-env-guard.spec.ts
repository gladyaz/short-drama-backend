import {
  SERIES_COVER_ORPHAN_ALLOWED_NODE_ENVS,
  SERIES_COVER_ORPHAN_APPLY_BUCKET_ENV,
  assertSeriesCoverOrphanApplyAllowed,
} from './series-cover-orphan-env-guard';

/**
 * Slice "SERIES COVER ORPHAN CLEANUP LIFECYCLE": the guard is the last thing
 * standing between `--apply` and a real bucket, so every branch is driven
 * explicitly and every unsafe input is asserted to REFUSE — never to warn,
 * never to default-allow.
 */
describe('assertSeriesCoverOrphanApplyAllowed', () => {
  const BUCKET = 'some-bucket';

  describe('NODE_ENV allowlist', () => {
    it.each(SERIES_COVER_ORPHAN_ALLOWED_NODE_ENVS)(
      'permits NODE_ENV=%s when the bucket is confirmed',
      (nodeEnv) => {
        expect(() =>
          assertSeriesCoverOrphanApplyAllowed(nodeEnv, BUCKET, BUCKET),
        ).not.toThrow();
      },
    );

    it.each([
      ['production', 'production'],
      ['staging', 'staging'],
      ['a typo', 'produciton'],
      ['an empty string', ''],
      ['an uppercase variant', 'Development'],
    ])('refuses %s', (_label, nodeEnv) => {
      expect(() =>
        assertSeriesCoverOrphanApplyAllowed(nodeEnv, BUCKET, BUCKET),
      ).toThrow(/fail-closed ALLOWLIST/);
    });

    it('refuses a genuinely UNSET NODE_ENV rather than treating it as non-production', () => {
      // Deliberately mutates and restores `process.env` instead of passing
      // `undefined`: an explicit `undefined` argument activates the default
      // parameter (`process.env.NODE_ENV`, which Jest sets to "test"), so it
      // would silently exercise the ALLOWED path and prove nothing. This is
      // the only way to reach the truly-unset branch.
      const originalNodeEnv = process.env.NODE_ENV;

      try {
        delete process.env.NODE_ENV;

        expect(() =>
          assertSeriesCoverOrphanApplyAllowed(
            process.env.NODE_ENV,
            BUCKET,
            BUCKET,
          ),
        ).toThrow(/NODE_ENV=null/);
      } finally {
        restoreEnv('NODE_ENV', originalNodeEnv);
      }
    });
  });

  describe('bucket identity confirmation', () => {
    it('refuses when OBJECT_STORAGE_BUCKET is unset', () => {
      // Same default-parameter trap as the NODE_ENV case above: an explicit
      // `undefined` activates `process.env.OBJECT_STORAGE_BUCKET`, which is
      // set on a normal dev laptop and leaks into this worker whenever a
      // sibling suite imports `dotenv/config`. Clear it so the unset branch
      // is actually the one under test.
      const originalBucket = process.env.OBJECT_STORAGE_BUCKET;

      try {
        delete process.env.OBJECT_STORAGE_BUCKET;

        expect(() =>
          assertSeriesCoverOrphanApplyAllowed('development', undefined, BUCKET),
        ).toThrow(/OBJECT_STORAGE_BUCKET is unset or empty/);
      } finally {
        restoreEnv('OBJECT_STORAGE_BUCKET', originalBucket);
      }
    });

    it('refuses when OBJECT_STORAGE_BUCKET is an empty string', () => {
      expect(() =>
        assertSeriesCoverOrphanApplyAllowed('development', '', BUCKET),
      ).toThrow(/OBJECT_STORAGE_BUCKET is unset or empty/);
    });

    it('refuses when the operator confirmation variable is unset', () => {
      // The crucial case: a normal dev laptop has NODE_ENV=development and a
      // real bucket configured. That alone must NOT be enough. Cleared for
      // the same default-parameter reason as OBJECT_STORAGE_BUCKET above,
      // even though the standing guard at the bottom of this file asserts
      // the variable never exists in the test environment.
      const originalConfirmation =
        process.env[SERIES_COVER_ORPHAN_APPLY_BUCKET_ENV];

      try {
        delete process.env[SERIES_COVER_ORPHAN_APPLY_BUCKET_ENV];

        expect(() =>
          assertSeriesCoverOrphanApplyAllowed('development', BUCKET, undefined),
        ).toThrow(
          new RegExp(
            `${SERIES_COVER_ORPHAN_APPLY_BUCKET_ENV} is unset or empty`,
          ),
        );
      } finally {
        restoreEnv(SERIES_COVER_ORPHAN_APPLY_BUCKET_ENV, originalConfirmation);
      }
    });

    it('refuses when the operator confirmation names a DIFFERENT bucket', () => {
      expect(() =>
        assertSeriesCoverOrphanApplyAllowed(
          'development',
          BUCKET,
          'some-other-bucket',
        ),
      ).toThrow(/does not match OBJECT_STORAGE_BUCKET/);
    });

    it('permits an exact match', () => {
      expect(() =>
        assertSeriesCoverOrphanApplyAllowed('development', BUCKET, BUCKET),
      ).not.toThrow();
    });
  });

  it('checks NODE_ENV BEFORE the bucket, so a production env is refused as production', () => {
    // Ordering matters for the operator's error message: being in production
    // is the more important fact than the bucket name being unconfirmed.
    expect(() =>
      assertSeriesCoverOrphanApplyAllowed('production', undefined, undefined),
    ).toThrow(/fail-closed ALLOWLIST/);
  });

  it('names the tool and the safe alternative in every refusal', () => {
    expect(() =>
      assertSeriesCoverOrphanApplyAllowed('production', BUCKET, BUCKET),
    ).toThrow(/Re-run without --apply for a dry run/);
  });

  it('reads live process.env by default rather than a value captured at import time', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalBucket = process.env.OBJECT_STORAGE_BUCKET;
    const originalConfirmation =
      process.env[SERIES_COVER_ORPHAN_APPLY_BUCKET_ENV];

    try {
      process.env.NODE_ENV = 'production';
      process.env.OBJECT_STORAGE_BUCKET = BUCKET;
      process.env[SERIES_COVER_ORPHAN_APPLY_BUCKET_ENV] = BUCKET;

      expect(() => assertSeriesCoverOrphanApplyAllowed()).toThrow(
        /fail-closed ALLOWLIST/,
      );

      process.env.NODE_ENV = 'test';

      expect(() => assertSeriesCoverOrphanApplyAllowed()).not.toThrow();
    } finally {
      restoreEnv('NODE_ENV', originalNodeEnv);
      restoreEnv('OBJECT_STORAGE_BUCKET', originalBucket);
      restoreEnv(SERIES_COVER_ORPHAN_APPLY_BUCKET_ENV, originalConfirmation);
    }
  });

  it('refuses in THIS repository checkout, where no apply confirmation exists', () => {
    // A standing regression guard: if someone ever commits a
    // SERIES_COVER_ORPHAN_APPLY_BUCKET into a checked-in env file, or the
    // test environment gains one, this fails and forces the question.
    expect(process.env[SERIES_COVER_ORPHAN_APPLY_BUCKET_ENV] ?? '').toBe('');
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
