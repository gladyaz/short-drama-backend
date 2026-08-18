import 'dotenv/config';
import { runRegisteredFixtureSweep } from './jest-fixture-hygiene';

/** `globalTeardown` for the UNIT project. See `jest-global-setup.ts`. */
export default async function globalTeardown(): Promise<void> {
  await runRegisteredFixtureSweep('unit');
}
