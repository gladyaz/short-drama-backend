import 'dotenv/config';
import { runStaleFixtureSweep } from '../src/common/testing/jest-fixture-hygiene';

/**
 * `globalSetup` for the E2E project (`test/jest-e2e.json`). Runs once, in
 * the main process, before any worker is forked.
 *
 * `jest-e2e.setup.ts` redirects `DATABASE_URL` to `DATABASE_URL_TEST` for
 * every WORKER, but `setupFiles` never execute in the main process, so the
 * redirect is repeated here — otherwise this sweep would run against the dev
 * database while the suites it is cleaning up after ran against the test
 * one. `dotenv/config` is imported for the same reason: nothing else has
 * loaded `.env` this early.
 *
 * An unset `DATABASE_URL_TEST` is NOT thrown on here, unlike in
 * `jest-e2e.setup.ts`. That file must fail loudly because a spec would
 * otherwise write to the dev database; this one has no such consequence —
 * the guard in `stale-fixture-sweep.ts` refuses on its own, the sweep is
 * skipped, and `jest-e2e.setup.ts` still delivers the same loud failure a
 * moment later.
 */
export default async function globalSetup(): Promise<void> {
  await runStaleFixtureSweep('e2e', process.env.DATABASE_URL_TEST);
}
