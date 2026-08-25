import 'dotenv/config';
import { runR2MediaMigrationCli } from '../src/media/r2-migration/run-r2-media-migration-cli';

/**
 * Work unit "R2 MEDIA MIGRATION": the ONLY way to invoke
 * `R2MediaMigrationService`. Nothing in this repo runs it automatically —
 * no `@Cron`, no scheduler registration, no package.json pre/post hook, no
 * CI step, and no application boot path reaches it. A human types it.
 *
 * The catalog currently holds 40 published episodes whose media exists only
 * on a local filesystem. This tool moves them into object storage in four
 * separately-invoked steps, in this order:
 *
 * 1. INVENTORY — the default. Writes NOTHING to the bucket or the database.
 *    Prints the exact row -> storageKey -> local file -> objectStorageKey
 *    mapping it WOULD apply, and names every row it cannot resolve:
 *
 *      npm run media:r2-migrate
 *
 *    Add --check-remote to additionally HEAD each destination key (one
 *    read-only call per row; requires working credentials):
 *
 *      npm run media:r2-migrate -- --check-remote
 *
 * 2. UPLOAD — copies bytes into the bucket. Writes NOTHING to the database.
 *    Skips any destination already present at the correct size, so an
 *    interrupted run is resumed by re-running the same command:
 *
 *      R2_MEDIA_MIGRATION_APPLY_BUCKET="$OBJECT_STORAGE_BUCKET" \
 *      npm run media:r2-migrate -- --upload
 *
 * 3. VERIFY — read-only. HEADs every destination and compares byte length
 *    against the local source, so a truncated upload is caught BEFORE the
 *    catalog is repointed at it:
 *
 *      npm run media:r2-migrate -- --verify
 *
 * 4. LINK — the only step that writes to the database. Re-confirms each
 *    object by HEAD in the same run, immediately before setting that row's
 *    `objectStorageKey`, and skips any row whose object is absent or the
 *    wrong size:
 *
 *      R2_MEDIA_MIGRATION_APPLY_BUCKET="$OBJECT_STORAGE_BUCKET" \
 *      npm run media:r2-migrate -- --link
 *
 * This tool NEVER deletes, renames, or modifies a local source file, never
 * clears or overwrites an existing `objectStorageKey`, and never touches a
 * row that already has one — which is what keeps the two existing QA-fixture
 * rows out of its way entirely.
 *
 * Building this tool does not authorize running its writing modes anywhere.
 * Steps 2 and 4 are separate, human-approved actions against a real bucket.
 */
runR2MediaMigrationCli(process.argv).catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
