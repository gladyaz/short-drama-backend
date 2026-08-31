import { resolve } from 'path';
import { NestFactory } from '@nestjs/core';
import { LocalCoverIngestCliModule } from './local-cover-ingest-cli.module';
import { LocalCoverIngestService } from './local-cover-ingest.service';
import {
  LocalCoverIngestReport,
  LocalCoverIngestRunOptions,
} from './local-cover-ingest.types';

/**
 * Work unit "LOCAL SERIES COVER ARTWORK": argument parsing and human-readable
 * reporting for `scripts/ingest-series-covers.ts`.
 *
 * The committed default source. `assets/series-covers/` holds the four real
 * Red Panda covers as REVIEWABLE, named files — the same four bytes-for-bytes
 * that the public website ships in its own `public/posters/`, keyed the same
 * way (filename stem = `Series.id`). Defaulting here is what lets a fresh
 * checkout reach real artwork with one command instead of a path the operator
 * has to know.
 */
export const DEFAULT_COVER_ASSET_DIR = 'assets/series-covers';

export function parseCoverIngestArgs(
  argv: readonly string[],
): LocalCoverIngestRunOptions {
  const args = argv.slice(2);
  const known = new Set(['--apply', '--help']);

  for (const arg of args) {
    if (!known.has(arg) && !arg.startsWith('--source=')) {
      throw new Error(
        `Unknown argument: ${arg}. Valid: --apply | --source=DIR`,
      );
    }
  }

  const sourceArg = args.find((arg) => arg.startsWith('--source='));
  const source = sourceArg?.slice('--source='.length);

  // An explicitly EMPTY `--source=` is an error, never a silent fallback to
  // the default: it is what a mistyped or unset shell variable expands to,
  // and quietly ingesting the committed assets when the operator meant to
  // ingest their own directory would be the wrong kind of helpful.
  if (
    sourceArg !== undefined &&
    (source === undefined || source.length === 0)
  ) {
    throw new Error('--source= requires a directory path.');
  }

  return {
    sourceDir: resolve(source ?? DEFAULT_COVER_ASSET_DIR),
    apply: args.includes('--apply'),
  };
}

/** The report as an operator reads it: one line per series, then a summary. */
export function formatCoverIngestReport(
  report: LocalCoverIngestReport,
): string {
  const lines: string[] = [
    report.applied
      ? 'MODE: APPLY (files copied, rows updated)'
      : 'MODE: DRY RUN (nothing written)',
    `driver=${report.driver}`,
    `sourceDir=${report.sourceDir}`,
    `localRoot=${report.localRoot}`,
    '',
  ];

  for (const outcome of report.outcomes) {
    if (outcome.status === 'skipped' || outcome.status === 'failed') {
      lines.push(
        `${outcome.status.toUpperCase().padEnd(12)} ${outcome.seriesId}  ${outcome.reason}`,
      );
      continue;
    }

    const replaces =
      outcome.previousCoverImageKey === null
        ? 'no previous cover'
        : `replaces ${outcome.previousCoverImageKey}`;

    lines.push(
      `${outcome.status.toUpperCase().padEnd(12)} ${outcome.seriesId}  ` +
        `${outcome.contentType} ${outcome.bytes}B -> ${outcome.key}  (${replaces})`,
    );
  }

  const counted = (status: string): number =>
    report.outcomes.filter((outcome) => outcome.status === status).length;

  lines.push(
    '',
    `total=${report.outcomes.length} ingested=${counted('ingested')} ` +
      `wouldIngest=${counted('would-ingest')} skipped=${counted('skipped')} ` +
      `failed=${counted('failed')}`,
  );

  if (!report.applied && counted('would-ingest') > 0) {
    lines.push('', 'Re-run with --apply to write these.');
  }

  return lines.join('\n');
}

/**
 * Boots the standalone context, runs the ingest, prints the report, and closes
 * the context. Resolves to the process exit code: non-zero if ANY series
 * failed, so a partially-successful run cannot be mistaken for a clean one by
 * a script that only checks the status.
 */
export async function runLocalCoverIngestCli(
  argv: readonly string[],
): Promise<number> {
  const options = parseCoverIngestArgs(argv);
  const app = await NestFactory.createApplicationContext(
    LocalCoverIngestCliModule,
    { logger: ['error', 'warn'] },
  );

  try {
    const report = await app.get(LocalCoverIngestService).run(options);

    console.log(formatCoverIngestReport(report));

    return report.outcomes.some((outcome) => outcome.status === 'failed')
      ? 1
      : 0;
  } finally {
    await app.close();
  }
}
