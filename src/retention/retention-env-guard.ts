import { redactSensitiveText } from '../common/logging/redact';

/**
 * Phase 12, work unit 12D-B1: the production guard for `RetentionService`'s
 * destructive (`commit: true`) mode. This is a HARD, non-negotiable
 * requirement for this work unit — retention jobs delete data, and must
 * never be runnable against a production database this phase.
 *
 * Deliberately an ALLOWLIST (`NODE_ENV` must be exactly one of the values
 * below). `env.validation.ts`'s own boot-time check started out the
 * opposite shape — Phase 10, work unit 10-B5's exact-string
 * `!== 'production'` denylist, under which an unset `NODE_ENV` slipped
 * through silently. `TASK_QUEUE.md`'s Phase 12 follow-ups recorded that as
 * a MEDIUM finding (item 5). This work unit's own instructions required
 * this guard to be "robust to an unset value" rather than depending on
 * that pre-existing check, so this file's allowlist was built
 * independently of it: `undefined`, `''`, a typo (`'produciton'`), or any
 * value this file does not explicitly recognize as safe is treated as
 * UNSAFE, not as "probably fine because it isn't literally the word
 * production". Follow-up item 5 is now resolved — Phase 12, work unit
 * 12D-B2 (commit `7cfd411`) replaced `env.validation.ts`'s denylist with an
 * allowlist of its own, using this file's design as the model. The two
 * checks remain independent, separately maintained gates for two different
 * surfaces (dev-tools boot vs. this destructive retention job): this file
 * does not call into `env.validation.ts`, and neither is implemented in
 * terms of the other.
 *
 * Fast-follow (independent `test-reviewer` pass, MEDIUM): `NODE_ENV` alone
 * is necessary but not sufficient — a normal local dev shell legitimately
 * has `NODE_ENV=development` while `DATABASE_URL` resolves to
 * `short_drama_dev`, the real seeded/QA database. `assertDestructiveRetentionAllowed`
 * below now ALSO requires `assertDestructiveRetentionDatabaseAllowed` (see
 * further down this file) to pass — a second, independent gate on database
 * identity, not a replacement for the `NODE_ENV` allowlist above. Both must
 * pass for a destructive run to proceed; this mirrors the existing
 * fail-closed-on-unset-`DATABASE_URL_TEST` precedent already in
 * `retention.integration.spec.ts` and `test/jest-e2e.setup.ts`.
 */
export const RETENTION_DESTRUCTIVE_ALLOWED_NODE_ENVS = [
  'development',
  'test',
] as const;

export type RetentionAllowedNodeEnv =
  (typeof RETENTION_DESTRUCTIVE_ALLOWED_NODE_ENVS)[number];

/**
 * Throws if `nodeEnv` (defaults to the live `process.env.NODE_ENV` at call
 * time, not a value captured earlier) is not exactly one of
 * `RETENTION_DESTRUCTIVE_ALLOWED_NODE_ENVS`. Callers MUST invoke this BEFORE
 * issuing a single Prisma read or write for the destructive path — see
 * `RetentionService.run`, which calls this first, before any of its
 * per-target processing methods — so a refusal here means literally zero
 * database activity happened for this run, not merely "we decided not to
 * delete after already touching the database."
 */
export function assertDestructiveRetentionAllowed(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): void {
  const isAllowed = (
    RETENTION_DESTRUCTIVE_ALLOWED_NODE_ENVS as readonly string[]
  ).includes(nodeEnv ?? '');

  if (!isAllowed) {
    throw new Error(
      'Refusing to run retention cleanup destructively: ' +
        `NODE_ENV=${JSON.stringify(nodeEnv ?? null)} is not one of the ` +
        `explicitly allowed values (${RETENTION_DESTRUCTIVE_ALLOWED_NODE_ENVS.join(', ')}). ` +
        'This is a fail-closed ALLOWLIST, not an "!== production" check — an ' +
        'unset, misspelled, or unrecognized NODE_ENV is treated as unsafe by ' +
        'default. Retention jobs must never run destructively against a ' +
        "production database (see AGENT_RULES.md and this work unit's " +
        'acceptance criteria).',
    );
  }

  // Second, independent gate — see this function's doc comment and
  // `assertDestructiveRetentionDatabaseAllowed`'s own doc comment below.
  // Deliberately reached only once the NODE_ENV allowlist above has already
  // passed, and still strictly before `RetentionService.run` issues its
  // first Prisma call — this function as a whole remains the single
  // call-before-any-query choke point.
  assertDestructiveRetentionDatabaseAllowed();
}

/**
 * Fast-follow (independent `test-reviewer` pass on work unit 12D-B1,
 * MEDIUM): the destructive-run guard previously checked ONLY `NODE_ENV`,
 * never which database it was about to delete from — so
 * `NODE_ENV=development npm run retention -- --commit` passed the guard and
 * deleted against whatever `DATABASE_URL` currently resolved to, which in a
 * normal local `.env` is `short_drama_dev` (the real seeded catalog/QA
 * data), not a disposable test database.
 *
 * This function requires `DATABASE_URL` and `DATABASE_URL_TEST` to resolve
 * to the SAME database identity (protocol + host + port + database name,
 * deliberately excluding the `user:password@` segment — see
 * `safeDatabaseIdentity` below) before a destructive run is allowed to
 * proceed, mirroring the existing fail-closed-on-unset-`DATABASE_URL_TEST`
 * precedent in `retention.integration.spec.ts` and
 * `test/jest-e2e.setup.ts`. Every unsafe input is a refusal, never a
 * default-allow:
 *  - `DATABASE_URL` unset/empty      → refuse
 *  - `DATABASE_URL_TEST` unset/empty → refuse
 *  - either value fails to parse as a URL (malformed)   → refuse
 *  - the two resolve to different host/port/database    → refuse
 *
 * Never interpolates the raw `DATABASE_URL`/`DATABASE_URL_TEST` string (each
 * embeds a password) into the thrown message — only the credential-free
 * identity computed by `safeDatabaseIdentity` is ever used, and the
 * assembled message is additionally passed through
 * `redactSensitiveText` (`src/common/logging/redact.ts`, hardened in work
 * unit 12A-B4) as defense in depth, so a future edit that accidentally
 * reintroduces a raw connection string here still cannot leak a password.
 */
export function assertDestructiveRetentionDatabaseAllowed(
  databaseUrl: string | undefined = process.env.DATABASE_URL,
  databaseUrlTest: string | undefined = process.env.DATABASE_URL_TEST,
): void {
  if (!databaseUrl) {
    refuseDestructiveRetentionDatabase('DATABASE_URL is unset or empty.');
  }
  if (!databaseUrlTest) {
    refuseDestructiveRetentionDatabase('DATABASE_URL_TEST is unset or empty.');
  }

  const actualIdentity = safeDatabaseIdentity(databaseUrl);
  const testIdentity = safeDatabaseIdentity(databaseUrlTest);

  if (!actualIdentity || !testIdentity) {
    refuseDestructiveRetentionDatabase(
      'DATABASE_URL or DATABASE_URL_TEST is not a well-formed connection ' +
        'string (failed to parse).',
    );
  }

  if (actualIdentity !== testIdentity) {
    refuseDestructiveRetentionDatabase(
      `DATABASE_URL resolves to "${actualIdentity}", which is not the ` +
        `isolated test database ("${testIdentity}").`,
    );
  }
}

/**
 * Deliberately a top-level (not per-call-locally-scoped) `never`-returning
 * function — TypeScript's control-flow narrowing of a `string | undefined`
 * parameter to `string` after an `if (!value) { ... }` guard only applies
 * when the guard calls a statically-known `never`-returning function, not an
 * inline closure. Kept as a named helper (rather than duplicating the throw
 * at each call site) purely for that reason, not for reuse.
 */
function refuseDestructiveRetentionDatabase(reason: string): never {
  throw new Error(
    redactSensitiveText(
      'Refusing to run retention cleanup destructively: ' +
        `${reason} A destructive retention run must be pointed at the ` +
        'isolated test database (DATABASE_URL_TEST), never at whatever ' +
        'DATABASE_URL currently resolves to — this is a fail-closed check, ' +
        'independent of NODE_ENV, that never defaults to "allow".',
    ),
  );
}

/**
 * Derives a credential-free identity (protocol + host + port + database
 * name) from a raw connection string, or `null` if the string does not
 * parse as a URL at all. Deliberately omits `URL#username`/`URL#password` —
 * this repo's own `redact.ts` precedent already treats scheme/host/port/
 * database name as non-sensitive ("useful for debugging") and only the
 * `user:password@` segment as sensitive, so this function's return value is
 * safe to interpolate directly into a thrown error message.
 */
function safeDatabaseIdentity(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.hostname}:${parsed.port || 'default'}${parsed.pathname}`;
  } catch {
    return null;
  }
}
