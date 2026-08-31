import 'dotenv/config';
import { runLocalCoverIngestCli } from '../src/series/cover-ingest/run-local-cover-ingest-cli';

/**
 * Work unit "LOCAL SERIES COVER ARTWORK": the ONLY way to invoke
 * `LocalCoverIngestService`. Nothing in this repo runs it automatically —
 * no `@Cron`, no scheduler registration, no `package.json` pre/post hook, no
 * CI step and no application boot path reaches it. A human types the command.
 *
 * DEFAULT (no flags): a DRY RUN against the committed `assets/series-covers/`.
 * Reports what it would ingest and writes nothing:
 *
 *   npm run covers:ingest
 *
 * WRITING (`--apply`): copies each verified asset into the local object root
 * (`LOCAL_OBJECT_STORAGE_ROOT`, default `storage/local-objects`) and points
 * the matching `Series.coverImageKey` at it. Refused outright unless
 * `STORAGE_DRIVER=local`:
 *
 *   npm run covers:ingest -- --apply
 *
 * A different artwork directory (files named `<series id>.<ext>`):
 *
 *   npm run covers:ingest -- --source=/path/to/posters --apply
 */
runLocalCoverIngestCli(process.argv)
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
