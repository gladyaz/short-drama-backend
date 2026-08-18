import { randomBytes } from 'node:crypto';

/**
 * Width of the zero-padded base-36 process id inside `TEST_FIXTURE_NAMESPACE`.
 * 5 base-36 digits address 60,466,175 — comfortably above every platform's
 * `pid_max` (Linux's 4,194,304 ceiling included).
 */
const PID_RADIX36_WIDTH = 5;

/**
 * Per-process unique namespace for database fixtures created by tests.
 *
 * WHY THIS EXISTS (Auth test-stability slice): every integration-style spec
 * in this repo creates real rows in a real PostgreSQL database and cleans up
 * afterwards with a marker-scoped `deleteMany` (historically
 * `{ email: { contains: 'auth-service-spec+8b5' } }` and friends). That
 * marker was a *hardcoded literal*, identical in every checkout of this
 * repository. Because this project is developed across several git worktrees
 * (`short-drama-backend`, `short-drama-backend-auth-stability`,
 * `short-drama-backend-cover-concurrency`, ...) that all point at the SAME
 * `short_drama_dev` / `short_drama_test` databases, two Jest runs started in
 * two different worktrees at the same time would each delete the OTHER run's
 * in-flight fixtures mid-test. The observed symptoms were never local to the
 * test that failed:
 *
 *   - `Foreign key constraint violated on the constraint:
 *     "AuthAuditEvent_userId_fkey"` while emitting a `login_success` audit
 *     row for an account this same test had just registered,
 *   - `findUniqueOrThrow()` reporting "No record was found" for a row created
 *     moments earlier,
 *   - a password-reset token helper returning `undefined`, surfacing much
 *     later as `TypeError: The "data" argument must be of type string` inside
 *     `hashPasswordResetToken`,
 *   - and assertions failing against row counts that no code in the failing
 *     spec could have produced.
 *
 * That is the entire "Auth-family baseline flake" signature: it is not a
 * timing bug and not an ordering bug, it is one test run deleting another
 * run's data. It reproduces only when two runs overlap, which is exactly why
 * re-running a single suite "in isolation" made it disappear.
 *
 * The namespace below is derived from the OS process id (unique across every
 * live process on the machine, so two concurrent runs can never collide)
 * plus random bytes (so a recycled pid cannot collide with rows left behind
 * by a previously crashed run). It is a module-level constant, so it is
 * stable for the lifetime of one Jest worker's module registry — i.e. stable
 * across every test in one spec file, which is what the shared
 * `afterEach`/`afterAll` cleanup blocks rely on.
 *
 * USAGE CONTRACT — both halves are required:
 *   1. Every fixture identifier a spec creates must START with
 *      `TEST_FIXTURE_NAMESPACE` (use `fixtureEmail`/`fixtureMarker` below).
 *   2. Every cleanup predicate must be scoped with
 *      `{ startsWith: TEST_FIXTURE_NAMESPACE }`, never a hardcoded literal.
 *
 * Using `startsWith` (rather than `contains`) is deliberate: it makes the
 * predicate a prefix match that cannot accidentally match another run's rows,
 * and it means a stale checkout still running the old
 * `contains('auth-service-spec+8b5')` cleanup cannot match rows created by
 * this scheme either — so the fix is effective even before every worktree has
 * been updated.
 *
 * The pid segment is zero-padded to a FIXED width (review finding) so that
 * every namespace is exactly the same length. Without padding, a short pid's
 * namespace could be a strict prefix of a longer pid's, and a `startsWith`
 * cleanup would then delete the other run's rows — reintroducing, at low
 * probability, the exact failure this file exists to eliminate.
 *
 * KNOWN TRADE-OFF (review finding, accepted): the old hardcoded literal was
 * self-healing — the next run's `contains(<literal>)` swept whatever a
 * crashed or SIGINT'd previous run had left behind. A per-run namespace gives
 * that up: an interrupted run's rows are now orphaned in the dev/test
 * database permanently. This is a hygiene cost, not a correctness one (every
 * assertion in these specs is scoped to a unique per-test email, so leaked
 * rows cannot skew a count). A follow-up should add a `globalTeardown` that
 * sweeps `@example.test` rows older than a day; it is deliberately NOT done
 * here because a sweep wide enough to be useful is also wide enough to need
 * its own careful review.
 */
export const TEST_FIXTURE_NAMESPACE = `t${process.pid
  .toString(36)
  .padStart(PID_RADIX36_WIDTH, '0')}${randomBytes(3).toString('hex')}`;

/**
 * Monotonic within one worker process. Replaces the previous
 * `Date.now()`-plus-`Math.random()` suffix: two `uniqueEmail('same-label')`
 * calls in the same millisecond used to rely on `Math.random()` alone for
 * uniqueness, and the timestamp made every generated address 13 characters
 * longer for no benefit. A counter is shorter, collision-free by
 * construction, and deterministic — which also keeps failure output stable
 * and greppable between runs.
 */
let fixtureSequence = 0;

/**
 * Builds a namespaced, unique-per-call email address for a test fixture.
 * `label` is free-form and exists only to make a leaked row (or a failure
 * message) attributable to the test that created it.
 *
 * Kept short on purpose: `@IsEmail()` (via `validator.js`) enforces the
 * RFC 5321 64-character local-part limit, and the namespace + sequence
 * prefix costs ~14 characters, leaving ample room for a descriptive label.
 */
export function fixtureEmail(label: string): string {
  fixtureSequence += 1;
  return `${TEST_FIXTURE_NAMESPACE}-${fixtureSequence}-${label}@example.test`;
}

/**
 * Builds a namespaced marker string for the non-email columns some specs use
 * to find their own rows during cleanup — `AuthAuditEvent.userAgent` (rows
 * deliberately emitted WITHOUT a `userId`, so there is no relation to join
 * through) and `AnalyticsEvent.eventName`. Same namespace, same
 * `startsWith`-scoped cleanup contract as `fixtureEmail`.
 */
export function fixtureMarker(label: string): string {
  return `${TEST_FIXTURE_NAMESPACE}-${label}`;
}

/**
 * Like `fixtureMarker`, but unique per call — for specs that tag each row
 * with its own distinct marker and never need to reconstruct the value
 * later (`auth-audit.service.spec.ts`'s per-test `userAgent` values).
 * Shares `fixtureEmail`'s counter, so a marker and an email created in the
 * same run can never collide either.
 */
export function uniqueFixtureMarker(label: string): string {
  fixtureSequence += 1;
  return `${TEST_FIXTURE_NAMESPACE}-${fixtureSequence}-${label}`;
}
