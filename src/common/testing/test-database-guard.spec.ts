import { assertTestFixtureCleanupAllowed } from './test-database-guard';
import { sweepStaleTestFixtures } from './stale-fixture-sweep';

/**
 * The refusal matrix for the stale-fixture sweep's database guard.
 *
 * This file is the reason the sweep is allowed to exist at all: it is the
 * only test infrastructure in this repository that deletes rows it did not
 * create, so the interesting assertions here are the NEGATIVE ones — every
 * misconfiguration must be a refusal, and a refusal must happen before any
 * query is issued rather than after.
 *
 * Cases pass their inputs as arguments wherever possible, so nothing here
 * can leak a connection string into another spec sharing this worker. The
 * exception is the "unset" cases, which by their nature can only be
 * expressed by removing the variable — see `withoutEnv`.
 */

/**
 * Runs `body` with `names` removed from `process.env`, restoring them
 * afterwards even if `body` throws. Needed because the guard's parameters
 * default to the environment, so "unset" cannot be expressed as an argument.
 */
function withoutEnv(names: string[], body: () => void): void {
  const saved = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) {
    delete process.env[name];
  }
  try {
    body();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

describe('assertTestFixtureCleanupAllowed', () => {
  const LOCAL_DEV = 'postgresql://u:p@127.0.0.1:5432/short_drama_dev';
  const LOCAL_TEST = 'postgresql://u:p@127.0.0.1:5432/short_drama_test';

  describe('allows only an explicitly designated local server', () => {
    it('allows the isolated test database itself', () => {
      expect(() =>
        assertTestFixtureCleanupAllowed(LOCAL_TEST, LOCAL_TEST, 'test'),
      ).not.toThrow();
    });

    it('allows the local dev database, because that is where src integration specs create fixtures', () => {
      expect(() =>
        assertTestFixtureCleanupAllowed(LOCAL_DEV, LOCAL_TEST, 'development'),
      ).not.toThrow();
    });

    it('allows localhost and IPv6 loopback, the other two spellings this project uses', () => {
      expect(() =>
        assertTestFixtureCleanupAllowed(
          'postgresql://u:p@localhost:5433/short_drama_dev',
          'postgresql://u:p@localhost:5433/short_drama_test',
          'test',
        ),
      ).not.toThrow();
      expect(() =>
        assertTestFixtureCleanupAllowed(
          'postgresql://u:p@[::1]:5432/short_drama_dev',
          'postgresql://u:p@[::1]:5432/short_drama_test',
          'test',
        ),
      ).not.toThrow();
    });
  });

  describe('refuses on NODE_ENV', () => {
    it('refuses in production', () => {
      expect(() =>
        assertTestFixtureCleanupAllowed(LOCAL_TEST, LOCAL_TEST, 'production'),
      ).toThrow(/NODE_ENV="production" is not one of the explicitly allowed/);
    });

    // The allowlist shape matters more than the production case: these are
    // the values an `!== 'production'` denylist would have waved through.
    it.each([
      ['empty', ''],
      ['a typo', 'produciton'],
      ['staging', 'staging'],
    ])('refuses when NODE_ENV is %s', (_label, nodeEnv) => {
      expect(() =>
        assertTestFixtureCleanupAllowed(LOCAL_TEST, LOCAL_TEST, nodeEnv),
      ).toThrow(/is not one of the explicitly allowed values/);
    });

    // Exercised through `process.env` rather than as an argument: each
    // parameter defaults to its environment variable, so passing `undefined`
    // would silently re-read the live (perfectly valid) value and assert
    // nothing. "Unset" is only expressible by actually unsetting it, which
    // is also how it would occur in reality.
    it('refuses when NODE_ENV is unset entirely', () => {
      withoutEnv(['NODE_ENV'], () => {
        expect(() =>
          assertTestFixtureCleanupAllowed(LOCAL_TEST, LOCAL_TEST),
        ).toThrow(/NODE_ENV=null is not one of the explicitly allowed/);
      });
    });
  });

  describe('refuses on database target', () => {
    it('refuses when DATABASE_URL_TEST is unset, i.e. no disposable database was ever declared', () => {
      withoutEnv(['DATABASE_URL_TEST'], () => {
        expect(() =>
          assertTestFixtureCleanupAllowed(LOCAL_DEV, undefined, 'development'),
        ).toThrow(/DATABASE_URL_TEST is unset or empty/);
      });
    });

    it('refuses when DATABASE_URL is unset', () => {
      withoutEnv(['DATABASE_URL'], () => {
        expect(() =>
          assertTestFixtureCleanupAllowed(undefined, LOCAL_TEST, 'test'),
        ).toThrow(/DATABASE_URL is unset or empty/);
      });
    });

    it.each([
      ['DATABASE_URL', '', LOCAL_TEST],
      ['DATABASE_URL_TEST', LOCAL_TEST, ''],
    ])('refuses when %s is set but empty', (_label, databaseUrl, testUrl) => {
      expect(() =>
        assertTestFixtureCleanupAllowed(databaseUrl, testUrl, 'test'),
      ).toThrow(/is unset or empty/);
    });

    it('refuses a remote production host even when NODE_ENV lies', () => {
      expect(() =>
        assertTestFixtureCleanupAllowed(
          'postgresql://u:p@db.production.example.com:5432/short_drama',
          LOCAL_TEST,
          'development',
        ),
      ).toThrow(/is not on the same server as the declared test database/);
    });

    it('refuses a different port on the same host — a second, unrelated PostgreSQL instance', () => {
      expect(() =>
        assertTestFixtureCleanupAllowed(
          'postgresql://u:p@127.0.0.1:6000/short_drama_dev',
          LOCAL_TEST,
          'test',
        ),
      ).toThrow(/is not on the same server as the declared test database/);
    });

    it('refuses a remote host even when DATABASE_URL_TEST points at the SAME remote host', () => {
      // The pair is self-consistent, so the host/port check passes and only
      // the loopback requirement stands between this and a remote deletion.
      expect(() =>
        assertTestFixtureCleanupAllowed(
          'postgresql://u:p@db.example.com:5432/short_drama_dev',
          'postgresql://u:p@db.example.com:5432/short_drama_test',
          'test',
        ),
      ).toThrow(/whose host is not a loopback address/);
    });

    it('refuses a hostname that merely looks local', () => {
      expect(() =>
        assertTestFixtureCleanupAllowed(
          'postgresql://u:p@localhost.attacker.example:5432/short_drama',
          'postgresql://u:p@localhost.attacker.example:5432/short_drama_test',
          'test',
        ),
      ).toThrow(/whose host is not a loopback address/);
    });

    it.each([
      ['DATABASE_URL', 'not-a-url', LOCAL_TEST],
      ['DATABASE_URL_TEST', LOCAL_TEST, 'not-a-url'],
    ])('refuses when %s is malformed', (_label, databaseUrl, testUrl) => {
      expect(() =>
        assertTestFixtureCleanupAllowed(databaseUrl, testUrl, 'test'),
      ).toThrow(/failed to parse/);
    });
  });

  it('never leaks a password into the refusal message', () => {
    // Covers both the interpolation risk (the guard only ever formats a
    // credential-free identity) and the defence-in-depth redaction pass.
    let message = '';
    try {
      assertTestFixtureCleanupAllowed(
        'postgresql://admin:hunter2@db.production.example.com:5432/app',
        'postgresql://admin:hunter2@127.0.0.1:5432/short_drama_test',
        'development',
      );
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('is not on the same server');
    expect(message).not.toContain('hunter2');
  });
});

describe('sweepStaleTestFixtures refusal', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('issues ZERO Prisma calls when the target database is not allowed', async () => {
    // A guard that refuses only after reading is not a guard. Asserting on
    // the client rather than on the thrown error is what proves the refusal
    // happened before any statement reached the database.
    process.env.DATABASE_URL =
      'postgresql://u:p@db.production.example.com:5432/short_drama';
    process.env.NODE_ENV = 'development';

    const forbidden = (): never => {
      throw new Error('the sweep touched the database after refusing');
    };
    const prisma = {
      user: { findMany: jest.fn(forbidden), deleteMany: jest.fn(forbidden) },
      series: { findMany: jest.fn(forbidden), deleteMany: jest.fn(forbidden) },
      video: { deleteMany: jest.fn(forbidden) },
      authAuditEvent: {
        findMany: jest.fn(forbidden),
        deleteMany: jest.fn(forbidden),
      },
      analyticsEvent: {
        findMany: jest.fn(forbidden),
        deleteMany: jest.fn(forbidden),
      },
    };

    await expect(sweepStaleTestFixtures(prisma as never)).rejects.toThrow(
      /Refusing to sweep stale test fixtures/,
    );

    for (const model of Object.values(prisma)) {
      for (const method of Object.values(model)) {
        expect(method).not.toHaveBeenCalled();
      }
    }
  });
});
