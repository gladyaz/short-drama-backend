import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SeriesCoverOrphanCliModule } from './series-cover-orphan-cli.module';
import { assertSeriesCoverOrphanApplyAllowed } from './series-cover-orphan-env-guard';
import { SeriesCoverOrphanService } from './series-cover-orphan.service';
import { SeriesCoverOrphanReport } from './series-cover-orphan.types';

/**
 * Slice "SERIES COVER ORPHAN CLEANUP LIFECYCLE": the implementation behind
 * `scripts/run-series-cover-orphans.ts` (`npm run
 * maintenance:series-cover-orphans`).
 *
 * Lives under `src/` rather than in the `scripts/` entry file for exactly the
 * reason `run-retention-cli.ts` does: this repo's Jest `rootDir` is `src`, so
 * only a file here can have a normal `*.spec.ts` beside it. The `scripts/`
 * file stays a thin entry point that loads `.env` and calls this.
 *
 * ## Ordering guarantee
 *
 * For an `--apply` invocation the environment gate runs BEFORE
 * `deps.createContext()` — i.e. before the Nest context, `PrismaService`, or
 * the `S3Client` is constructed at all. A refusal therefore means zero
 * database connections and zero storage calls happened, not "we refused
 * after already connecting". Same ordering fix `run-retention-cli.ts` made
 * for the retention CLI; the in-service gate in
 * `SeriesCoverOrphanService.run` is an independent second layer, not a
 * replacement for this one.
 *
 * ## Dry run is the default
 *
 * With no flags this reports what WOULD be removed and removes nothing, and
 * needs none of the `--apply` gates — so it is safe to run against any
 * environment for inspection.
 */
export interface RunSeriesCoverOrphansCliDeps {
  /** Defaults to the real guard. Overridable purely for this file's own spec. */
  assertApplyAllowed: () => void;
  /**
   * Defaults to booting `SeriesCoverOrphanCliModule`. Kept as an injectable
   * factory so the spec can assert, by construction, that it was NEVER
   * invoked when the gate refuses.
   */
  createContext: () => Promise<INestApplicationContext>;
  /** Defaults to `console.log`, matching `run-retention-cli.ts`'s plain-stdout convention. */
  log: (message: string) => void;
}

const defaultDeps: RunSeriesCoverOrphansCliDeps = {
  assertApplyAllowed: () => {
    assertSeriesCoverOrphanApplyAllowed();
  },
  createContext: () =>
    NestFactory.createApplicationContext(SeriesCoverOrphanCliModule, {
      logger: ['error', 'warn', 'log'],
    }),
  // `no-console` is not an active ESLint rule in this repo (see
  // `eslint.config.mjs`); like the retention CLI, this tool's report is
  // deliberately plain human-readable stdout rather than structured `Logger`
  // output.
  log: (message: string) => {
    console.log(message);
  },
};

export async function runSeriesCoverOrphansCli(
  argv: string[],
  deps: RunSeriesCoverOrphansCliDeps = defaultDeps,
): Promise<void> {
  const apply = argv.includes('--apply');

  // The ordering guarantee from this file's doc comment: the gate can refuse
  // strictly before any context/client/connection exists.
  if (apply) {
    deps.assertApplyAllowed();
  }

  const context = await deps.createContext();

  try {
    const service = context.get(SeriesCoverOrphanService);
    const report = await service.run({ apply });
    printReport(report, deps.log);
  } finally {
    await context.close();
  }
}

/**
 * Prints KEYS ONLY — never a presigned URL, never a bucket credential, never
 * an endpoint. A key is the entire identifier an operator needs to
 * investigate a candidate, and it carries no authorization by itself.
 */
function printReport(
  report: SeriesCoverOrphanReport,
  log: (message: string) => void,
): void {
  const heading = report.apply
    ? 'SERIES COVER ORPHAN SWEEP — APPLY (objects were removed)'
    : 'SERIES COVER ORPHAN SWEEP — DRY RUN (report only, nothing was removed)';

  log(heading);
  log(`Generated at:  ${report.generatedAt.toISOString()}`);
  log(
    `Grace window:  ${report.graceMs / 3_600_000}h ` +
      `(objects modified before ${report.cutoff.toISOString()} are old enough)`,
  );
  log(`Pages scanned: ${report.pagesScanned}`);
  log('');

  log(`scanned:                ${report.scanned}`);
  log(`  ignoredForeignKey:    ${report.ignoredForeignKey}`);
  log(`  protected:            ${report.protected}`);
  log(`  unknownAge:           ${report.unknownAge}`);
  log(`  tooRecent:            ${report.tooRecent}`);
  log(`  seriesRecentlyModified: ${report.seriesRecentlyModified}`);
  log(`  eligible:             ${report.eligible}`);
  log(`deleted:                ${report.deleted}`);
  log(`failed:                 ${report.failed}`);
  log(`skippedOnRecheck:       ${report.skippedOnRecheck}`);
  log('');

  if (report.candidates.length > 0) {
    log('Eligible candidates:');
    for (const candidate of report.candidates) {
      log(
        `  ${candidate.key}  series=${candidate.seriesId}  ` +
          `age=${Math.round(candidate.ageMs / 3_600_000)}h  ` +
          `reason=${candidate.reason}  outcome=${candidate.outcome}`,
      );
    }
    log('');
  }

  if (report.candidatesTruncated) {
    log(
      'NOTE: more candidates existed than this report lists individually. ' +
        'The counters above are still exact and complete.',
    );
  }

  if (report.listTruncated) {
    log(
      'WARNING: the object listing was TRUNCATED at this sweep’s page ' +
        'ceiling — this run did NOT examine the entire Series-cover ' +
        'namespace. Re-run after resolving the candidates above.',
    );
  }

  if (!report.apply) {
    log(
      'This was a DRY RUN. Nothing was removed. To act on the candidates ' +
        'above, re-run with --apply, which additionally requires ' +
        'NODE_ENV=development or test AND SERIES_COVER_ORPHAN_APPLY_BUCKET ' +
        'set to exactly the same value as OBJECT_STORAGE_BUCKET.',
    );
  }
}
