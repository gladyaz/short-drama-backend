import 'dotenv/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { RetentionService } from '../src/retention/retention.service';
import { RetentionReport } from '../src/retention/retention.types';

/**
 * Phase 12, work unit 12D-B1: the ONLY way to invoke `RetentionService` at
 * all. This script is NEVER run automatically by anything in this repo (no
 * `@Cron`, no `package.json` `pre`/`post` hook, no CI step, no startup
 * code) — a human must type the command below by hand.
 *
 * DEFAULT (no flags): a DRY RUN. Prints exactly what WOULD be deleted;
 * deletes nothing, against ANY database (see `RetentionService.run`, which
 * literally never calls a `deleteMany` unless `commit: true`):
 *
 *   npm run retention
 *
 * DESTRUCTIVE (`--commit`): additionally requires BOTH of two independent
 * gates in `../src/retention/retention-env-guard.ts` to pass — (1) `NODE_ENV`
 * must be exactly `development` or `test` (an ALLOWLIST, robust to an unset
 * `NODE_ENV`, unlike `env.validation.ts`'s pre-existing exact-string
 * `!== 'production'` check flagged in `TASK_QUEUE.md`'s Phase 12 follow-up
 * item 5), AND (2) `DATABASE_URL` must resolve to the SAME database as
 * `DATABASE_URL_TEST` (`assertDestructiveRetentionDatabaseAllowed`) — added
 * as a fast-follow because `NODE_ENV=development` alone is not sufficient: a
 * normal local dev shell has `NODE_ENV=development` while `DATABASE_URL`
 * legitimately points at `short_drama_dev`, the real seeded/QA database, so
 * that alone must not be enough to permit a destructive run:
 *
 *   NODE_ENV=development DATABASE_URL="$DATABASE_URL_TEST" npm run retention -- --commit
 *
 * This work unit's own scope explicitly does NOT run this destructively
 * against any real data this phase (see `phases/phase-12.md` "12D" —
 * "built and tested this phase but not run against production data"), and
 * `AGENT_RULES.md` separately forbids running any destructive tool against
 * `short_drama_dev`/real company data regardless of what this script's own
 * guard allows. This CLI is deliberately generic/reusable infrastructure —
 * ITS existence does not itself authorize running it anywhere.
 */
async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');

  const prisma = new PrismaService();
  await prisma.onModuleInit();

  try {
    const service = new RetentionService(prisma);
    const report = await service.run({ commit });
    printReport(report);
  } finally {
    await prisma.onModuleDestroy();
  }
}

function printReport(report: RetentionReport): void {
  const heading = report.commit
    ? 'RETENTION RUN — DESTRUCTIVE (rows were deleted)'
    : 'RETENTION DRY RUN — report only, nothing was deleted';

  // eslint-disable-next-line no-console
  console.log(`${heading}`);
  // eslint-disable-next-line no-console
  console.log(`Generated at: ${report.generatedAt.toISOString()}`);
  // eslint-disable-next-line no-console
  console.log('');

  for (const target of report.targets) {
    const cutoffText = target.cutoff
      ? ` (cutoff: ${target.cutoff.toISOString()})`
      : '';
    // eslint-disable-next-line no-console
    console.log(
      `${target.target}: matched=${target.matchedCount} deleted=${target.deletedCount}${cutoffText}`,
    );

    for (const detail of target.residueDetails ?? []) {
      // eslint-disable-next-line no-console
      console.log(
        `  - ${detail.model}: matched=${detail.matchedCount} deleted=${detail.deletedCount}`,
      );
    }
  }

  // eslint-disable-next-line no-console
  console.log('');
  if (!report.commit) {
    // eslint-disable-next-line no-console
    console.log(
      'This was a DRY RUN. Pass --commit (with NODE_ENV=development or ' +
        'test, AND DATABASE_URL pointed at the same database as ' +
        'DATABASE_URL_TEST) to actually delete the rows listed above.',
    );
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
