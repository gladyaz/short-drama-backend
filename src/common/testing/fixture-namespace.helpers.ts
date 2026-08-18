import { randomBytes } from 'node:crypto';
import { registerTestFixtureNamespace } from './fixture-namespace-registry';

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
 *
 * RESOLVED (Test-infrastructure hardening slice): that follow-up is now
 * `stale-fixture-sweep.ts`, run from `globalSetup`/`globalTeardown`. It is
 * narrower than the sketch above — it reclaims rows by NAMESPACE SHAPE
 * (`TEST_FIXTURE_NAMESPACE_PATTERN` below) rather than by email domain, so
 * it cannot touch a developer's QA account, and it requires the namespace to
 * have been silent for hours, so it cannot touch a run still in flight.
 */
export const TEST_FIXTURE_NAMESPACE = `t${process.pid
  .toString(36)
  .padStart(PID_RADIX36_WIDTH, '0')}${randomBytes(3).toString('hex')}`;

/**
 * The SHAPE of a generated namespace: the literal `t`, up to
 * `PID_RADIX36_WIDTH` base-36 digits of a process id, then six hex digits
 * from `randomBytes(3)`.
 *
 * This is the ownership test the stale-fixture sweep applies before deleting
 * anything (`stale-fixture-sweep.ts`), so it lives HERE, beside the
 * construction it describes, rather than being restated at the point of use.
 * A pattern that drifted from the generator would either orphan rows forever
 * or — far worse — start matching rows nobody generated;
 * `fixture-namespace.helpers.spec.ts` asserts the two agree.
 *
 * `{1,PID_RADIX36_WIDTH}` rather than an exact width, deliberately: the pid
 * segment has only been zero-padded since the Auth test-stability slice
 * added `padStart`, and developer databases still hold rows from before that
 * change whose pid segment is three or four characters
 * (`t7u0ba830e-...`, `tn7se2b179-...`). Those are abandoned fixtures from
 * this same generator and there is no reason to orphan them permanently. A
 * base-36 pid cannot exceed five digits on any platform this repo runs on
 * (Linux's 4,194,304 ceiling is `2gosw`), so the range covers every
 * namespace this repository has ever produced and nothing wider.
 *
 * Deliberately not a global regex: `exec` on a `/g` pattern carries
 * `lastIndex` between calls, which would make a shared module-level constant
 * return different answers for the same input depending on call order.
 */
export const TEST_FIXTURE_NAMESPACE_PATTERN = new RegExp(
  `^t[0-9a-z]{1,${PID_RADIX36_WIDTH}}[0-9a-f]{6}$`,
);

/**
 * How a namespace appears at the START of a fixture marker, capturing the
 * namespace itself.
 *
 * The trailing hyphen is load-bearing, not decoration. Every generator below
 * emits `<namespace>-<something>` (`fixtureEmail`, `fixtureMarker`,
 * `uniqueFixtureMarker`), and requiring it here buys two things at once:
 *
 *  - It removes the only ambiguity a variable-width pid segment could
 *    introduce. Without a fixed right-hand boundary, `t7u0ba830e-...` could
 *    be read as a 2-digit pid plus `0ba830` OR a 3-digit pid plus `ba830e`,
 *    and a `startsWith` delete built from the shorter reading would reach
 *    beyond the namespace that actually owns the row.
 *  - It narrows what can be claimed as a fixture at all. A marker must be a
 *    namespace FOLLOWED BY a hyphen — so a name that merely happens to open
 *    with the right letters (`tester123abc@example.test`) is not a
 *    candidate.
 */
export const TEST_FIXTURE_MARKER_PATTERN = new RegExp(
  `^(t[0-9a-z]{1,${PID_RADIX36_WIDTH}}[0-9a-f]{6})-`,
);

/**
 * The domain every fixture address is generated under. `.test` is an
 * IANA-reserved TLD (RFC 6761) that can never resolve, so a fixture address
 * can never reach a real mailbox — and, for the stale-fixture sweep, an
 * address outside this domain is never a `User` cleanup candidate no matter
 * what its local part looks like.
 */
export const TEST_FIXTURE_EMAIL_DOMAIN = '@example.test';

/**
 * Announces this worker's namespace to the run that forked it, so
 * `globalTeardown` can reclaim its rows even if a suite's own `afterAll`
 * never ran (it threw, or the database was briefly unreachable while it
 * ran). The main Jest process cannot derive this value for itself — the
 * namespace is a function of the WORKER's pid — which is the whole reason
 * the registry exists; see `fixture-namespace-registry.ts`.
 *
 * A module-level side effect is unusual, and is justified here by being the
 * only point at which the value exists in the process that owns it. It is
 * inert unless a `globalSetup` published a registry directory, it writes one
 * empty file, and it cannot throw.
 */
registerTestFixtureNamespace(TEST_FIXTURE_NAMESPACE);

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
  return `${TEST_FIXTURE_NAMESPACE}-${fixtureSequence}-${label}${TEST_FIXTURE_EMAIL_DOMAIN}`;
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
