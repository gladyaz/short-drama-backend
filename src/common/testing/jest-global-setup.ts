import 'dotenv/config';
import { runStaleFixtureSweep } from './jest-fixture-hygiene';

/**
 * `globalSetup` for the UNIT project (`package.json` -> `jest`). Runs once,
 * in the main process, before any worker is forked.
 *
 * No database override: the `src/**` integration specs deliberately share
 * `DATABASE_URL` (the dev database) per this repo's existing precedent — see
 * `auth.service.spec.ts` — so that is the database whose abandoned fixtures
 * this gate is responsible for. See `jest-fixture-hygiene.ts` for the full
 * model and for why nothing here can fail the gate.
 */
export default async function globalSetup(): Promise<void> {
  await runStaleFixtureSweep('unit');
}
