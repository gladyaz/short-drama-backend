// Mirrors the existing `retention.integration.spec.ts`/`test/jest-e2e.setup.ts`
// precedent: load `.env` explicitly (this file otherwise never touches
// Prisma, so nothing else would load it) and fail closed if
// `DATABASE_URL_TEST` is not configured, rather than silently running the
// new database-identity gate's tests against `undefined`.
import 'dotenv/config';
import {
  assertDestructiveRetentionAllowed,
  assertDestructiveRetentionDatabaseAllowed,
  RETENTION_DESTRUCTIVE_ALLOWED_NODE_ENVS,
} from './retention-env-guard';

const TEST_DB_URL =
  'postgresql://user:secret-password@localhost:5433/short_drama_test';
const DEV_DB_URL =
  'postgresql://user:secret-password@localhost:5433/short_drama_dev';

if (!process.env.DATABASE_URL_TEST) {
  throw new Error(
    'DATABASE_URL_TEST is not set in .env — this spec exercises the ' +
      'destructive-retention database-identity gate and must be able to ' +
      'align DATABASE_URL to it. Copy .env.example and set ' +
      'DATABASE_URL_TEST before running npm test.',
  );
}

/**
 * Phase 12, work unit 12D-B1: pure, DB-free coverage of the production
 * guard. This is one of the two properties this work unit requires to be
 * proven non-vacuous by mutation (see `retention.service.spec.ts` and this
 * work unit's report for the mutation trial: temporarily replacing the
 * `includes` check with `true` and confirming every `it.each` "refuses"
 * case here fails, then restoring the source byte-for-byte).
 *
 * Fast-follow (independent `test-reviewer` pass, MEDIUM): every test in this
 * describe block only exercises the `NODE_ENV` allowlist, not the new
 * database-identity gate `assertDestructiveRetentionAllowed` now also
 * requires (see `assertDestructiveRetentionDatabaseAllowed` further down
 * this file). The file-level `beforeEach`/`afterEach` below aligns
 * `DATABASE_URL` to `DATABASE_URL_TEST` for every test in this file by
 * default, so the "allows"/"reads the live NODE_ENV" cases here keep testing
 * ONLY the NODE_ENV dimension they were written for — any test that
 * specifically wants to exercise a DATABASE_URL mismatch overrides it
 * locally and lets this `afterEach` restore it afterward.
 */
let originalDatabaseUrl: string | undefined;
let originalDatabaseUrlTest: string | undefined;

beforeEach(() => {
  originalDatabaseUrl = process.env.DATABASE_URL;
  originalDatabaseUrlTest = process.env.DATABASE_URL_TEST;
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
});

afterEach(() => {
  // Restores BOTH — some tests below deliberately reassign
  // `DATABASE_URL_TEST` itself (not just `DATABASE_URL`), and this repo's
  // Jest workers reuse one Node process across multiple `*.spec.ts` files,
  // so `process.env` mutations here would otherwise leak into whichever
  // spec file the same worker runs next.
  process.env.DATABASE_URL = originalDatabaseUrl;
  process.env.DATABASE_URL_TEST = originalDatabaseUrlTest;
});

describe('assertDestructiveRetentionAllowed', () => {
  it.each(RETENTION_DESTRUCTIVE_ALLOWED_NODE_ENVS)(
    'allows NODE_ENV=%s',
    (allowed) => {
      expect(() => assertDestructiveRetentionAllowed(allowed)).not.toThrow();
    },
  );

  it.each([
    ['production', 'the literal value this guard exists to block'],
    ['', 'empty string'],
    [
      'Production',
      'wrong case — an allowlist does not normalize case, by design',
    ],
    ['PRODUCTION', 'wrong case'],
    [
      'produciton',
      'a typo of "production" that a denylist would miss entirely',
    ],
    [
      'staging',
      'a real, plausible deployment environment this guard must still refuse',
    ],
    [
      'dev',
      'a plausible-looking but NOT allowlisted abbreviation of "development"',
    ],
  ])('refuses NODE_ENV=%s (%s)', (unsafeValue) => {
    expect(() => assertDestructiveRetentionAllowed(unsafeValue)).toThrow(
      /Refusing to run retention cleanup destructively/,
    );
  });

  // Passing the JS literal `undefined` as an argument is indistinguishable
  // from omitting the argument entirely (default parameters trigger on
  // `undefined`), so "unset NODE_ENV" can only be tested by actually
  // clearing `process.env.NODE_ENV` and calling with zero arguments — not
  // by passing `undefined` explicitly, which would just re-read whatever
  // `process.env.NODE_ENV` already is (e.g. Jest's own `'test'`).
  it("refuses when process.env.NODE_ENV is genuinely unset (TASK_QUEUE.md follow-up item 5's exact concern)", () => {
    const original = process.env.NODE_ENV;
    try {
      delete process.env.NODE_ENV;
      expect(() => assertDestructiveRetentionAllowed()).toThrow(
        /Refusing to run retention cleanup destructively/,
      );
      expect(() => assertDestructiveRetentionAllowed()).toThrow(
        /NODE_ENV=null/,
      );
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it('reads the live process.env.NODE_ENV when called with no argument', () => {
    const original = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(() => assertDestructiveRetentionAllowed()).toThrow();

      process.env.NODE_ENV = 'test';
      expect(() => assertDestructiveRetentionAllowed()).not.toThrow();
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it('includes the actually-supplied value in the thrown message without ever claiming a safe default', () => {
    expect(() => assertDestructiveRetentionAllowed('staging')).toThrow(
      /NODE_ENV="staging"/,
    );
  });

  /**
   * Fast-follow (independent `test-reviewer` pass, MEDIUM): proves the two
   * gates are wired together and BOTH independently fail closed — an
   * allowed `NODE_ENV` is no longer sufficient on its own. This is the
   * second property this fast-follow requires to be proven non-vacuous by
   * mutation (see this fix's report for the mutation trial: temporarily
   * removing the `assertDestructiveRetentionDatabaseAllowed()` call added to
   * the end of `assertDestructiveRetentionAllowed`, confirming every case
   * below fails, then restoring the source byte-for-byte).
   */
  describe('the database-identity gate is also enforced (both gates must pass)', () => {
    it('refuses when DATABASE_URL is not the test database, even with an allowed NODE_ENV=development', () => {
      process.env.DATABASE_URL = DEV_DB_URL;
      process.env.DATABASE_URL_TEST = TEST_DB_URL;

      expect(() => assertDestructiveRetentionAllowed('development')).toThrow(
        /Refusing to run retention cleanup destructively/,
      );
    });

    it('refuses when DATABASE_URL is not the test database, even with an allowed NODE_ENV=test', () => {
      process.env.DATABASE_URL = DEV_DB_URL;
      process.env.DATABASE_URL_TEST = TEST_DB_URL;

      expect(() => assertDestructiveRetentionAllowed('test')).toThrow();
    });

    it('allows when NODE_ENV is allowed AND DATABASE_URL matches DATABASE_URL_TEST', () => {
      process.env.DATABASE_URL = TEST_DB_URL;
      process.env.DATABASE_URL_TEST = TEST_DB_URL;

      expect(() => assertDestructiveRetentionAllowed('test')).not.toThrow();
    });

    it('still refuses on NODE_ENV alone (production) even when DATABASE_URL happens to match DATABASE_URL_TEST — the NODE_ENV allowlist is unweakened', () => {
      process.env.DATABASE_URL = TEST_DB_URL;
      process.env.DATABASE_URL_TEST = TEST_DB_URL;

      expect(() => assertDestructiveRetentionAllowed('production')).toThrow();
    });
  });
});

/**
 * Fast-follow (independent `test-reviewer` pass on work unit 12D-B1,
 * MEDIUM): direct, DB-free coverage of the new database-identity gate
 * itself, independent of `NODE_ENV`. Every "refuses" case here is one of
 * this fast-follow's required non-vacuous-by-mutation proofs (see this
 * fix's report for the mutation trial: temporarily replacing the
 * `actualIdentity !== testIdentity` comparison — and each unset/malformed
 * check above it — with an unconditional pass, confirming every case below
 * fails, then restoring the source byte-for-byte).
 */
describe('assertDestructiveRetentionDatabaseAllowed', () => {
  it('allows when DATABASE_URL and DATABASE_URL_TEST resolve to the same database identity', () => {
    expect(() =>
      assertDestructiveRetentionDatabaseAllowed(TEST_DB_URL, TEST_DB_URL),
    ).not.toThrow();
  });

  it('allows when the two connection strings differ only in credentials (user:password), proving the identity check is credential-independent', () => {
    const sameDbDifferentCreds =
      'postgresql://someone-else:different-password@localhost:5433/short_drama_test';

    expect(() =>
      assertDestructiveRetentionDatabaseAllowed(
        sameDbDifferentCreds,
        TEST_DB_URL,
      ),
    ).not.toThrow();
  });

  it('refuses when DATABASE_URL points at a different database than DATABASE_URL_TEST, even though both are well-formed', () => {
    expect(() =>
      assertDestructiveRetentionDatabaseAllowed(DEV_DB_URL, TEST_DB_URL),
    ).toThrow(/Refusing to run retention cleanup destructively/);
  });

  // Passing the JS literal `undefined` as an argument is indistinguishable
  // from omitting the argument entirely (default parameters trigger on
  // `undefined`, re-reading the live `process.env` value instead) — mirrors
  // `assertDestructiveRetentionAllowed`'s own identical caveat above, so
  // "unset" is proven by actually clearing `process.env.DATABASE_URL` and
  // calling with zero arguments, not by passing `undefined` explicitly.
  it('refuses when DATABASE_URL is unset', () => {
    process.env.DATABASE_URL_TEST = TEST_DB_URL;
    delete process.env.DATABASE_URL;

    expect(() => assertDestructiveRetentionDatabaseAllowed()).toThrow(
      /DATABASE_URL is unset or empty/,
    );
  });

  it('refuses when DATABASE_URL is an empty string', () => {
    expect(() =>
      assertDestructiveRetentionDatabaseAllowed('', TEST_DB_URL),
    ).toThrow(/DATABASE_URL is unset or empty/);
  });

  it('refuses when DATABASE_URL_TEST is unset', () => {
    process.env.DATABASE_URL = TEST_DB_URL;
    delete process.env.DATABASE_URL_TEST;

    expect(() => assertDestructiveRetentionDatabaseAllowed()).toThrow(
      /DATABASE_URL_TEST is unset or empty/,
    );
  });

  it('refuses when DATABASE_URL_TEST is an empty string', () => {
    expect(() =>
      assertDestructiveRetentionDatabaseAllowed(TEST_DB_URL, ''),
    ).toThrow(/DATABASE_URL_TEST is unset or empty/);
  });

  it('refuses when DATABASE_URL is malformed (fails to parse as a URL)', () => {
    expect(() =>
      assertDestructiveRetentionDatabaseAllowed(
        'not-a-connection-string',
        TEST_DB_URL,
      ),
    ).toThrow(/not a well-formed connection string/);
  });

  it('refuses when DATABASE_URL_TEST is malformed (fails to parse as a URL)', () => {
    expect(() =>
      assertDestructiveRetentionDatabaseAllowed(
        TEST_DB_URL,
        'not-a-connection-string',
      ),
    ).toThrow(/not a well-formed connection string/);
  });

  it('never includes the password from either connection string in the thrown message', () => {
    expect.assertions(2);
    try {
      assertDestructiveRetentionDatabaseAllowed(DEV_DB_URL, TEST_DB_URL);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The assertion above only means something if the guard actually
      // refused (proving the try block really threw, not that the catch
      // block was simply skipped).
      expect(message).toMatch(
        /Refusing to run retention cleanup destructively/,
      );
      expect(message).not.toContain('secret-password');
    }
  });

  it('reads the live process.env.DATABASE_URL / DATABASE_URL_TEST when called with no arguments', () => {
    process.env.DATABASE_URL_TEST = TEST_DB_URL;

    process.env.DATABASE_URL = DEV_DB_URL;
    expect(() => assertDestructiveRetentionDatabaseAllowed()).toThrow();

    process.env.DATABASE_URL = TEST_DB_URL;
    expect(() => assertDestructiveRetentionDatabaseAllowed()).not.toThrow();
  });
});
