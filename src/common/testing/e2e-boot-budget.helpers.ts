import { bcryptTestBudgetMs } from './bcrypt-test-budget.helpers';

/**
 * Derived Jest hook timeout for e2e suites, sized from the measured cost of
 * booting the real Nest `AppModule` instead of Jest's inherited 5000ms
 * default.
 *
 * WHY THIS EXISTS (Series test-isolation slice). Every `.e2e-spec.ts` in this
 * repository builds the full `AppModule` in `beforeAll` — module graph
 * construction, `ValidationPipe`/filter wiring, `app.init()`, and the
 * `PrismaService.onModuleInit` connect. That work is cheap on an idle
 * machine and expensive when several Jest workers do it AT THE SAME TIME,
 * which is the normal condition during a full e2e gate (Jest defaults to
 * `cores - 1` workers).
 *
 * Measured on this project's development hardware (8 logical cores), cold
 * boot per worker, with a busy test database:
 *
 *   - ~1.4 s with a single worker (no contention)
 *   - 2.6-4.3 s with 4 concurrent workers
 *   - 2.7-3.1 s with 8 concurrent spec files (7 workers, full-gate shape)
 *
 * Against a 5000ms default that leaves as little as ~700ms of headroom, and
 * `test/series.e2e-spec.ts` spends part of the same hook on TWO real
 * cost-factor-12 bcrypt hashes registering its admin and non-admin users.
 * The result was not a slow test but a WRONG one: `thrown: "Exceeded
 * timeout of 5000 ms for a hook"` failed all 88 tests in that file at once,
 * every one of them for a reason unrelated to what it asserts. Reproduced
 * on the pre-slice baseline in 6 of 6 runs under a controlled parallel load,
 * so this is a pre-existing latent defect that a full parallel gate exposes,
 * not a regression introduced by this slice.
 *
 * That 5000ms was never a decision anyone made about these suites: it is
 * Jest's out-of-the-box default, inherited by suites it does not fit.
 * Nothing in them asserts how LONG application boot takes.
 *
 * CRITICAL DISTINCTION (same as `bcrypt-test-budget.helpers.ts`): this is a
 * HARNESS budget — the point at which Jest should conclude a hook is hung
 * rather than slow. It is NOT a business timeout. No production timeout,
 * token lifetime, lockout window, or throttle window is affected. Nor is it
 * a retry: a test that fails still fails, exactly once. And it is NOT a
 * substitute for fixing real isolation defects — the global-count races this
 * slice removed were fixed by scoping the assertions, never by widening a
 * timing window.
 *
 * RULE FOR USING THIS: a derived budget may only ever RAISE an existing
 * explicit timeout, never lower it. A hand-set value chosen in response to a
 * real observed failure carries information this derivation does not.
 *
 * ---------------------------------------------------------------------
 * HOW TO APPLY IT (Test-infrastructure hardening slice)
 * ---------------------------------------------------------------------
 *
 * Prefer the PER-HOOK form, passing the budget as the hook's second
 * argument:
 *
 *   beforeAll(async () => {
 *     ...boot AppModule, register fixtures...
 *   }, e2eSuiteBootBudgetMs(2));
 *
 * rather than a file-level `jest.setTimeout`. The defect this budget exists
 * to remove is confined to the HOOK — a boot Jest allows 5000ms, whose
 * overrun fails every test in the file at once, before a single assertion
 * runs. A file-level call also widens every TEST's budget, which is a weaker
 * hang detector for cases that do no booting at all. Four files do carry a
 * file-level budget as well (`export.e2e-spec.ts` and
 * `log-redaction.e2e-spec.ts`, because their individual TESTS drive real
 * bcrypt work through the HTTP stack; `series.e2e-spec.ts` and
 * `series-public.e2e-spec.ts`, budgeted file-level by the Series isolation
 * slice); each states its own reason locally.
 *
 * `it(name, fn, budget)` takes the same value as a third argument, which is
 * how `dev-tools-boot-guard.e2e-spec.ts` — whose module compile happens
 * inside the test rather than a hook — is covered.
 *
 * COUNTING THE ARGUMENT. Count real cost-factor-12 operations in the HOOK
 * BODY, not in the file: `POST /auth/register` = 1 hash, `POST /auth/login`
 * = 1 compare, `POST /dev/admin/grant-role` = 0 (it only updates a column).
 * A hook that merely boots passes no argument at all.
 *
 * WHAT WAS RE-MEASURED FOR THIS SLICE. `MEASURED_COLD_APP_BOOT_MS` below is
 * deliberately LEFT ALONE. Instrumenting the boot as its own spec file,
 * replicated across eight workers inside a real full e2e gate on the same
 * 8-core hardware, put `compile()` + `createNestApplication()` + `init()` at
 * 470-814ms, and 1,387ms worst case with a full unit gate running
 * concurrently — comfortably under the 4,400ms figure. The constant is not
 * lowered to match, for the reason stated in the RULE above: a derived
 * budget may only rise. The newer numbers are recorded here as
 * corroboration that the existing budget has ample headroom, not as a
 * reason to shrink it.
 *
 * NOT COVERED, deliberately. Suites that already carry an explicit
 * `bcryptTestBudgetMs(8)` file-level budget (the auth family) are untouched:
 * 10,800ms is roughly eight times their measured hook cost, so their hooks
 * are not the inherited-default defect this slice fixes, and raising them to
 * 13,200ms would be churn without evidence. The unit project's module-
 * compiling `beforeEach` hooks are likewise out of scope here; several were
 * observed timing out under the same deliberately overloaded reproduction,
 * and that remains open.
 */

/**
 * Per-boot cost to budget against — the SATURATED worst case above, not the
 * idle figure, because a full e2e gate is what saturates the machine.
 */
const MEASURED_COLD_APP_BOOT_MS = 4400;

/**
 * Headroom over the measured cost. A Jest timeout is a hang detector, so it
 * should sit well clear of the work's real cost: an over-tight one converts
 * "the machine was busy" into "the suite failed", which is the exact defect
 * this file exists to remove. 3x matches the factor
 * `bcrypt-test-budget.helpers.ts` already uses, and covers a machine running
 * meaningfully more concurrent work than this repository's own gate
 * produces.
 */
const APP_BOOT_SAFETY_FACTOR = 3;

/**
 * Budget for an e2e suite whose `beforeAll` boots the Nest `AppModule` and
 * then performs `bcryptOperations` real cost-factor-12 hashes or comparisons
 * (`register` = 1 hash, `login` = 1 compare; a dev-only role grant performs
 * none). Count them from the hook body, not from the suite's name.
 *
 * The bcrypt component is delegated to `bcryptTestBudgetMs` rather than
 * re-derived, so the two budgets cannot drift apart. Passing 0 — the common
 * case for a suite with no authentication — yields the boot budget alone.
 */
export function e2eSuiteBootBudgetMs(bcryptOperations = 0): number {
  const bootBudget = MEASURED_COLD_APP_BOOT_MS * APP_BOOT_SAFETY_FACTOR;

  if (bcryptOperations === 0) {
    return bootBudget;
  }

  return bootBudget + bcryptTestBudgetMs(bcryptOperations);
}
