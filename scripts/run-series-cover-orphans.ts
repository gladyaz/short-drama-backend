import 'dotenv/config';
import { runSeriesCoverOrphansCli } from '../src/series/cover-orphans/run-series-cover-orphans-cli';

/**
 * Slice "SERIES COVER ORPHAN CLEANUP LIFECYCLE": the ONLY way to invoke
 * `SeriesCoverOrphanService` at all. Nothing in this repo runs this script
 * automatically — there is no `@Cron`, no scheduler registration, no
 * `package.json` pre/post hook, no CI step, and no application boot path that
 * reaches it. A human must type the command by hand.
 *
 * DEFAULT (no flags): a DRY RUN. Lists the orphan candidates it found, with
 * each one's key, series, age, and why it qualified. Removes nothing, against
 * any bucket — `SeriesCoverOrphanService.run` never reaches `deleteObject`
 * without `apply: true`:
 *
 *   npm run maintenance:series-cover-orphans
 *
 * DESTRUCTIVE (`--apply`): additionally requires BOTH gates in
 * `../src/series/cover-orphans/series-cover-orphan-env-guard.ts` to pass —
 * (1) `NODE_ENV` exactly `development` or `test` (a fail-closed ALLOWLIST,
 * robust to an unset value), AND (2) `SERIES_COVER_ORPHAN_APPLY_BUCKET` set
 * to exactly the same value as `OBJECT_STORAGE_BUCKET`, so the operator has
 * independently restated which bucket this specific run may act on:
 *
 *   NODE_ENV=development \
 *   SERIES_COVER_ORPHAN_APPLY_BUCKET="$OBJECT_STORAGE_BUCKET" \
 *   npm run maintenance:series-cover-orphans -- --apply
 *
 * The work unit that BUILT this lifecycle explicitly did not run it
 * destructively against any real bucket: a real apply run is a separate,
 * human-approved action. This CLI being reusable infrastructure does not
 * itself authorize running it anywhere.
 */
runSeriesCoverOrphansCli(process.argv).catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
