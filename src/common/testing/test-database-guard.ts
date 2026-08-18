import { redactSensitiveText } from '../logging/redact';
import { RETENTION_DESTRUCTIVE_ALLOWED_NODE_ENVS } from '../../retention/retention-env-guard';

/**
 * Fail-closed gate for the Jest stale-fixture sweep
 * (`stale-fixture-sweep.ts`). Nothing in this repository may delete rows on
 * a test harness's behalf until this function has returned without throwing.
 *
 * WHY THIS EXISTS (Test-infrastructure hardening slice). The sweep this
 * guards is the only piece of test infrastructure in this repository that
 * deletes rows it did NOT create in the same process. That makes it the one
 * place where a misconfigured `DATABASE_URL` could turn a `npm test`
 * invocation into a production deletion, so it is gated the same way
 * `RetentionService`'s destructive mode already is: an explicit ALLOWLIST of
 * conditions, every one of which must hold, and where an unset, malformed,
 * or unrecognized value is treated as UNSAFE rather than "probably fine".
 *
 * Deliberately NOT a hostname sniff. The strongest signal this project
 * actually has is its own configuration: `DATABASE_URL_TEST` is the variable
 * a developer sets to say "this specific PostgreSQL instance is the one I
 * have designated as disposable" (`.env.example`, `test/jest-e2e.setup.ts`,
 * `retention.integration.spec.ts`). The loopback check below is an
 * ADDITIONAL condition on top of that declaration, never a substitute for
 * it — see the conditions list.
 *
 * ALL of the following must hold, or the sweep refuses:
 *
 *  1. `NODE_ENV` is exactly one of
 *     `RETENTION_DESTRUCTIVE_ALLOWED_NODE_ENVS` (`development`, `test`).
 *     Imported rather than redeclared, so this project cannot end up with
 *     two allowlists that drift apart; a production process never satisfies
 *     it, and neither does an unset or misspelled value.
 *  2. `DATABASE_URL_TEST` is set and parses as a URL — i.e. this checkout
 *     has explicitly declared a disposable test database at all. A
 *     production deployment has no reason to set it, and its absence is by
 *     itself a refusal.
 *  3. `DATABASE_URL` is set and parses as a URL.
 *  4. The two resolve to the SAME host and port. This is what makes the
 *     sweep's reach a property of configuration rather than of guesswork:
 *     the only server it can ever touch is the one the developer already
 *     pointed `DATABASE_URL_TEST` at.
 *  5. That shared host is a loopback address. A developer's disposable
 *     PostgreSQL runs on their own machine (`docker-compose.yml` binds
 *     `127.0.0.1` only; `.env.example` uses `localhost`), so requiring
 *     loopback costs nothing here and removes the entire class of "the test
 *     database and the real database happen to share a remote host".
 *
 * Note what this deliberately does NOT require: that `DATABASE_URL` and
 * `DATABASE_URL_TEST` name the SAME database.
 * `assertDestructiveRetentionDatabaseAllowed` does require that, because
 * retention deletes by business rule and must therefore be confined to the
 * throwaway database. This sweep is different in kind: it deletes only rows
 * carrying a marker that is structurally impossible for non-test data to
 * hold (see `stale-fixture-sweep.ts`), and it must be able to reach
 * `short_drama_dev` because that is where the `src/**` integration specs
 * create their fixtures (see `auth.service.spec.ts`). Conditions 1-5 are
 * what keeps "reaches the local dev database" from meaning "reaches any
 * database".
 *
 * Never interpolates a raw connection string (each embeds a password) into
 * the thrown message — only the credential-free identity computed by
 * `parseDatabaseTarget`, and the assembled message is additionally passed
 * through `redactSensitiveText` as defense in depth, exactly as
 * `retention-env-guard.ts` does.
 */
export function assertTestFixtureCleanupAllowed(
  databaseUrl: string | undefined = process.env.DATABASE_URL,
  databaseUrlTest: string | undefined = process.env.DATABASE_URL_TEST,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): void {
  const isNodeEnvAllowed = (
    RETENTION_DESTRUCTIVE_ALLOWED_NODE_ENVS as readonly string[]
  ).includes(nodeEnv ?? '');

  if (!isNodeEnvAllowed) {
    refuseTestFixtureCleanup(
      `NODE_ENV=${JSON.stringify(nodeEnv ?? null)} is not one of the ` +
        `explicitly allowed values (${RETENTION_DESTRUCTIVE_ALLOWED_NODE_ENVS.join(', ')}).`,
    );
  }

  if (!databaseUrlTest) {
    refuseTestFixtureCleanup(
      'DATABASE_URL_TEST is unset or empty, so this checkout has not ' +
        'declared a disposable test database at all.',
    );
  }

  if (!databaseUrl) {
    refuseTestFixtureCleanup('DATABASE_URL is unset or empty.');
  }

  const target = parseDatabaseTarget(databaseUrl);
  const declaredTest = parseDatabaseTarget(databaseUrlTest);

  if (!target || !declaredTest) {
    refuseTestFixtureCleanup(
      'DATABASE_URL or DATABASE_URL_TEST is not a well-formed connection ' +
        'string (failed to parse).',
    );
  }

  if (
    target.hostname !== declaredTest.hostname ||
    target.port !== declaredTest.port
  ) {
    refuseTestFixtureCleanup(
      `DATABASE_URL resolves to "${target.identity}", which is not on the ` +
        `same server as the declared test database ("${declaredTest.identity}").`,
    );
  }

  if (!LOOPBACK_HOSTNAMES.has(target.hostname)) {
    refuseTestFixtureCleanup(
      `DATABASE_URL resolves to "${target.identity}", whose host is not a ` +
        'loopback address.',
    );
  }
}

/**
 * The hostnames treated as "this developer's own machine". Deliberately an
 * exact-match set rather than a pattern: `127.0.0.1` and `::1` are the only
 * loopback literals this project's own configuration uses
 * (`docker-compose.yml`, `.env.example`), and `localhost` is the name they
 * resolve to. A hostname this set does not contain is unsafe by default —
 * including one that merely *looks* local (`db.localhost.evil.example`).
 * Note `new URL()` normalizes an IPv6 host to bracketed form, which is why
 * `[::1]` appears here rather than a bare `::1`.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

interface DatabaseTarget {
  readonly hostname: string;
  readonly port: string;
  /** Credential-free, safe to interpolate into an error message. */
  readonly identity: string;
}

/**
 * Splits a raw connection string into the parts this guard compares, or
 * `null` if it does not parse as a URL at all. `identity` deliberately omits
 * `URL#username`/`URL#password`, matching `retention-env-guard.ts`'s
 * `safeDatabaseIdentity` and this repo's `redact.ts` precedent, which treats
 * scheme/host/port/database name as non-sensitive and only the
 * `user:password@` segment as sensitive.
 */
function parseDatabaseTarget(rawUrl: string): DatabaseTarget | null {
  try {
    const parsed = new URL(rawUrl);
    return {
      hostname: parsed.hostname,
      port: parsed.port || 'default',
      identity: `${parsed.protocol}//${parsed.hostname}:${parsed.port || 'default'}${parsed.pathname}`,
    };
  } catch {
    return null;
  }
}

/**
 * Top-level (not inline) `never`-returning helper for the same reason
 * `refuseDestructiveRetentionDatabase` is one: TypeScript narrows a
 * `string | undefined` parameter to `string` after an `if (!value) { ... }`
 * guard only when the guard calls a statically-known `never`-returning
 * function.
 */
function refuseTestFixtureCleanup(reason: string): never {
  throw new Error(
    redactSensitiveText(
      'Refusing to sweep stale test fixtures: ' +
        `${reason} The sweep deletes rows, so it may only run against a ` +
        'loopback PostgreSQL server that this checkout has explicitly ' +
        'designated for testing via DATABASE_URL_TEST. This is a ' +
        'fail-closed check that never defaults to "allow".',
    ),
  );
}
