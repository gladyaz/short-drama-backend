import 'dotenv/config';
import { runRegisteredFixtureSweep } from '../src/common/testing/jest-fixture-hygiene';

/** `globalTeardown` for the E2E project. See `jest-e2e.global-setup.ts`. */
export default async function globalTeardown(): Promise<void> {
  await runRegisteredFixtureSweep('e2e', process.env.DATABASE_URL_TEST);
}
