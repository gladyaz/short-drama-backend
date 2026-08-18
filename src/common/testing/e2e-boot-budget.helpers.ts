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
