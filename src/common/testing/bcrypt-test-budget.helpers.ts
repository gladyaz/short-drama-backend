/**
 * Derived Jest timeouts for the auth specs, sized from the measured cost of
 * real password hashing instead of Jest's inherited 5000ms default.
 *
 * WHY THIS EXISTS (Auth test-stability slice). The auth specs are
 * integration-style: they call the real `AuthService` against a real
 * database, so every `register`/`login`/`changePassword`/`deleteAccount` in a
 * test performs a REAL `bcryptjs` operation at the production
 * `BCRYPT_COST_FACTOR` (12). That cost is deliberate and must not be lowered
 * — a test that hashes at a weaker cost factor than production is no longer
 * testing production's hashing.
 *
 * Measured on this project's development hardware (8 logical cores,
 * `bcryptjs` — a pure-JS implementation, not a native binding):
 *
 *   - ~295 ms per cost-factor-12 hash on an otherwise idle machine
 *   - ~440 ms per hash with Jest's default worker pool (cores - 1) saturated
 *
 * A single ordinary test in `auth.service.spec.ts` performs 4-8 such
 * operations, i.e. 1.2-3.5 SECONDS of irreducible CPU work before a single
 * database round trip. Jest's 5000ms default therefore left some tests
 * running at ~70% of their budget in the best case, and they failed with
 * `Exceeded timeout of 5000 ms for a test` whenever the machine was busy —
 * which was read as "an Auth-family flake" for several development slices.
 *
 * That 5000ms was never a decision anyone made about auth: it is Jest's
 * out-of-the-box default, inherited by a suite it does not fit. Nothing in
 * these tests asserts how LONG authentication takes.
 *
 * TWO RULES FOR USING THIS (review findings):
 *
 *  1. A derived budget may only ever RAISE an existing explicit timeout,
 *     never lower it. `MEASURED_BCRYPT_COST12_MS` is calibrated on 8-core
 *     development hardware; a 2-vCPU CI runner is several times slower per
 *     operation, so a hand-set value chosen in response to a real observed CI
 *     timeout carries information this derivation does not have. See the
 *     `locks the account after 10 failed logins` test in
 *     `auth.service.spec.ts`, which is deliberately left at its original
 *     60000 for exactly this reason.
 *  2. Count the operations from the test body, not from the test's name.
 *
 * CRITICAL DISTINCTION: this is a HARNESS budget — the point at which Jest
 * should conclude a test is hung rather than slow. It is NOT a
 * business-security timeout. No production timeout, token lifetime, lockout
 * window, or throttle window is affected by anything in this file; those live
 * in `auth.constants.ts` and are untouched. Nor is this a retry: a test that
 * fails still fails, exactly once.
 */

/**
 * Per-operation cost to budget against — the SATURATED figure above, not the
 * idle one, because the suite's own worker pool is what saturates the machine
 * during a full run.
 */
const MEASURED_BCRYPT_COST12_MS = 450;

/**
 * Headroom over the measured cost. A Jest timeout is a hang detector, so it
 * should sit well clear of the work's real cost: an over-tight one converts
 * "the machine was busy" into "the test failed", which is the exact defect
 * this file exists to remove. 3x covers database round trips, Nest module
 * construction, and a machine running roughly 4x more concurrent hashing than
 * this suite alone produces.
 */
const BCRYPT_BUDGET_SAFETY_FACTOR = 3;

/**
 * Floor, so a test with one or two hashes still gets a sane budget. Note this
 * dominates for any argument <= 7 (7 x 450 x 3 = 9,450), so the per-file
 * budgets below that threshold are simply "the floor" — the operation counts
 * in their doc comments explain the suite, they do not change the number. The
 * derivation is only load-bearing for the larger per-test budgets.
 */
const MIN_BUDGET_MS = 10_000;

/**
 * Budget for a test performing `bcryptOperations` real cost-factor-12 hashes
 * or comparisons. Count them from the test body: `register` = 1 (hash),
 * `login` = 1 (compare), `deleteAccount` = 1 (compare), `changePassword` = 2
 * (compare + hash), `confirmPasswordReset` = 1 (hash), and multiply by the
 * iteration count of any loop the test runs.
 */
export function bcryptTestBudgetMs(bcryptOperations: number): number {
  return Math.max(
    MIN_BUDGET_MS,
    bcryptOperations * MEASURED_BCRYPT_COST12_MS * BCRYPT_BUDGET_SAFETY_FACTOR,
  );
}
