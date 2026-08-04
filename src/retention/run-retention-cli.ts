import { PrismaService } from '../prisma/prisma.service';
import { assertDestructiveRetentionAllowed } from './retention-env-guard';
import { RetentionService } from './retention.service';
import { RetentionReport } from './retention.types';

/**
 * Phase 13, work unit 13A-B1 (closes `TASK_QUEUE.md` follow-up item 22,
 * approved `DECISIONS.md` 2026-08-04): the actual CLI implementation behind
 * `scripts/run-retention.ts` — pulled into `src/retention/` (rather than
 * staying inline in the `scripts/` entry file) purely so this file lives
 * under this repo's Jest `rootDir` (`src`, per `package.json`'s `jest`
 * config) and can have a normal `*.spec.ts` regression test next to it.
 * `scripts/run-retention.ts` itself becomes a thin entry point that only
 * loads `.env` and calls `runRetentionCli(process.argv)` — same npm script
 * (`npm run retention`), same `--commit` flag, same stdout report format.
 *
 * **The fix this work unit makes:** previously, `main()` (the code that used
 * to live directly in `scripts/run-retention.ts`) constructed `PrismaService`
 * and called `prisma.onModuleInit()` (a raw `$connect()`) BEFORE
 * `assertDestructiveRetentionAllowed()` ran — so a `--commit` invocation
 * against a real, reachable database opened a live authenticated TCP
 * connection before the safety gate had a chance to refuse (see
 * `TASK_QUEUE.md` follow-up item 22 for the full incident writeup; verified
 * at the time to be data-safe — zero SQL queries were ever issued in that
 * window — but the connection handshake itself was real, which made the
 * "a refusal means zero database activity" claim in this repo's docs
 * slightly stronger than what the code actually guaranteed).
 *
 * **The fix:** when `--commit` is present, `assertDestructiveRetentionAllowed()`
 * below runs BEFORE `deps.createPrisma()` is ever called — i.e. before
 * `PrismaService` is constructed OR `$connect()` is invoked at all. A
 * refusal now means literally zero database activity, including the
 * connection handshake, making the docs' claim exactly true. Dry runs
 * (no `--commit`) are unaffected — they never delete, so they still
 * construct `PrismaService` unconditionally and never call this gate at
 * all (see `run-retention-cli.spec.ts`'s "dry run" case).
 *
 * **Defense in depth, unchanged:** `RetentionService.run` still calls
 * `assertDestructiveRetentionAllowed()` itself as the very first thing it
 * does whenever `commit: true` is passed to it directly (i.e. by any other,
 * non-CLI caller) — that in-service call is deliberately left untouched by
 * this work unit. This file's gate and that one are independent layers, not
 * a replacement for one another.
 */
export interface RunRetentionCliDeps {
  /** Defaults to the real guard from `./retention-env-guard`. Overridable purely for `run-retention-cli.spec.ts`'s own tests. */
  assertDestructiveRetentionAllowed: (nodeEnv?: string) => void;
  /**
   * Defaults to `() => new PrismaService()`. Kept as an injectable factory
   * (rather than inlining `new PrismaService()` below) so
   * `run-retention-cli.spec.ts` can wrap the REAL `PrismaService` class in a
   * `jest.fn()` spy and assert, by construction, that this factory — and
   * therefore the real constructor — was never invoked when the gate
   * refuses.
   */
  createPrisma: () => PrismaService;
  /** Defaults to `(prisma) => new RetentionService(prisma)`, mirroring `createPrisma` above for the identical testability reason. */
  createRetentionService: (prisma: PrismaService) => RetentionService;
  /** Defaults to `console.log`. Overridable so tests can silence/capture CLI stdout without touching global state. */
  log: (message: string) => void;
}

const defaultDeps: RunRetentionCliDeps = {
  assertDestructiveRetentionAllowed,
  createPrisma: () => new PrismaService(),
  createRetentionService: (prisma) => new RetentionService(prisma),
  // `no-console` is not an active ESLint rule in this repo's config (see
  // `eslint.config.mjs`) — unlike the rest of `src/`, which uses Nest's
  // structured `Logger` instead of raw `console.*`, this CLI's report output
  // is deliberately plain, human-readable stdout, matching the pre-13A-B1
  // behavior this default preserves byte-for-byte.
  log: (message: string) => {
    console.log(message);
  },
};

export async function runRetentionCli(
  argv: string[],
  deps: RunRetentionCliDeps = defaultDeps,
): Promise<void> {
  const commit = argv.includes('--commit');

  // See this file's doc comment above: this is the ordering fix itself —
  // the gate is reached, and can refuse, strictly before `deps.createPrisma()`
  // is ever called for a `--commit` run.
  if (commit) {
    deps.assertDestructiveRetentionAllowed();
  }

  const prisma = deps.createPrisma();
  await prisma.onModuleInit();

  try {
    const service = deps.createRetentionService(prisma);
    const report = await service.run({ commit });
    printReport(report, deps.log);
  } finally {
    await prisma.onModuleDestroy();
  }
}

function printReport(
  report: RetentionReport,
  log: (message: string) => void,
): void {
  const heading = report.commit
    ? 'RETENTION RUN — DESTRUCTIVE (rows were deleted)'
    : 'RETENTION DRY RUN — report only, nothing was deleted';

  log(`${heading}`);
  log(`Generated at: ${report.generatedAt.toISOString()}`);
  log('');

  for (const target of report.targets) {
    const cutoffText = target.cutoff
      ? ` (cutoff: ${target.cutoff.toISOString()})`
      : '';
    log(
      `${target.target}: matched=${target.matchedCount} deleted=${target.deletedCount}${cutoffText}`,
    );

    for (const detail of target.residueDetails ?? []) {
      log(
        `  - ${detail.model}: matched=${detail.matchedCount} deleted=${detail.deletedCount}`,
      );
    }
  }

  log('');
  if (!report.commit) {
    log(
      'This was a DRY RUN. Pass --commit (with NODE_ENV=development or ' +
        'test, AND DATABASE_URL pointed at the same database as ' +
        'DATABASE_URL_TEST) to actually delete the rows listed above.',
    );
  }
}
