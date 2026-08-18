import { PrismaClient } from '@prisma/client';
import {
  createFixtureNamespaceRegistry,
  discardFixtureNamespaceRegistry,
  readRegisteredFixtureNamespaces,
} from './fixture-namespace-registry';
import {
  StaleFixtureSweepResult,
  sweepStaleTestFixtures,
} from './stale-fixture-sweep';

/**
 * The `globalSetup` / `globalTeardown` bodies shared by both Jest projects in
 * this repository — the unit project (`package.json` -> `jest`, which runs
 * against `DATABASE_URL`) and the e2e project (`test/jest-e2e.json`, which
 * runs against `DATABASE_URL_TEST`). Written once here so the two gates
 * cannot acquire divergent cleanup behaviour; each config contributes only
 * its own two-line entry point.
 *
 * THE THREE-LAYER CLEANUP MODEL this completes:
 *
 *   1. `globalSetup` (`runStaleFixtureSweep`) — reclaims namespaces left by
 *      PREVIOUS runs that never got to clean up. This is the layer that
 *      matters, because it is the only one that still works when a run was
 *      SIGKILLed, lost its terminal, or had its machine shut down: nothing
 *      runs in a process that no longer exists.
 *   2. Per-suite `afterEach`/`afterAll` (unchanged, in the specs) — reclaims
 *      the CURRENT namespace on a normal exit. Still the primary mechanism;
 *      nothing here replaces or relaxes it.
 *   3. `globalTeardown` (`runRegisteredFixtureSweep`) — best-effort backstop
 *      for the current run, covering the gap where a suite's own `afterAll`
 *      threw partway through. It is NOT a crash-recovery mechanism and
 *      cannot be: Jest does not run `globalTeardown` for a process that was
 *      killed.
 *
 * Neither entry point may fail a gate. A refusal from the database guard, an
 * unreachable database, a read-only temp directory: all are reported as a
 * single line and stepped over. Test hygiene that can break a green build is
 * worse than the leaked rows it exists to prevent, and every refusal here is
 * still fail-CLOSED in the sense that matters — it declines to delete.
 *
 * COVERAGE NOTE. Each gate sweeps the database it is configured against, so
 * between them both local databases are covered: the unit gate reclaims
 * `short_drama_dev` (where `src/**` integration specs create fixtures) and
 * the e2e gate reclaims `short_drama_test`. The few unit specs that
 * redirect themselves to `DATABASE_URL_TEST`
 * (`account-deletion.service.spec.ts`, `change-password-session-timezone.spec.ts`,
 * `retention.integration.spec.ts`) therefore fall outside their own gate's
 * teardown, and are reclaimed by the e2e gate's age-based setup sweep
 * instead.
 */
const LOG_PREFIX = '[stale-fixture-sweep]';

/**
 * `globalSetup`: publish a namespace registry for this run's workers, then
 * reclaim rows abandoned by earlier runs.
 *
 * `databaseUrl`, when given, is applied to `process.env.DATABASE_URL` before
 * anything connects — the e2e project passes `DATABASE_URL_TEST` here for
 * the same reason `test/jest-e2e.setup.ts` does it for workers, and because
 * `globalSetup` runs in the main process, where that file has not executed.
 */
export async function runStaleFixtureSweep(
  label: string,
  databaseUrl?: string,
): Promise<void> {
  if (databaseUrl) {
    process.env.DATABASE_URL = databaseUrl;
  }

  createFixtureNamespaceRegistry();

  await withPrisma(label, async (prisma) => {
    const result = await sweepStaleTestFixtures(prisma);
    report(label, 'abandoned by earlier runs', result);
  });
}

/**
 * `globalTeardown`: reclaim the namespaces this run's own workers
 * registered, then drop the registry.
 *
 * Age is deliberately not consulted — see `SweepStaleTestFixturesOptions`.
 * These namespaces belong to worker processes that have already exited, so
 * there is no in-flight run for the age rule to protect. On a healthy run
 * every one of them has already been emptied by its suite's `afterAll` and
 * this sweep deletes nothing; the counts only become non-zero when that
 * cleanup did not complete.
 */
export async function runRegisteredFixtureSweep(
  label: string,
  databaseUrl?: string,
): Promise<void> {
  if (databaseUrl) {
    process.env.DATABASE_URL = databaseUrl;
  }

  const namespaces = readRegisteredFixtureNamespaces();

  if (namespaces.length > 0) {
    await withPrisma(label, async (prisma) => {
      const result = await sweepStaleTestFixtures(prisma, {
        onlyNamespaces: namespaces,
      });
      report(label, "left behind by this run's own suites", result);
    });
  }

  discardFixtureNamespaceRegistry();
}

/**
 * Runs `work` against a short-lived client and always disconnects. A client
 * left connected here would hold a PostgreSQL connection open for the whole
 * gate and — in `globalTeardown` — would keep the Node process alive after
 * Jest believes it is done.
 */
async function withPrisma(
  label: string,
  work: (prisma: PrismaClient) => Promise<void>,
): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await work(prisma);
  } catch (error) {
    // Never fails the gate — see this file's header.
    console.warn(`${LOG_PREFIX} ${label}: skipped (${describeError(error)})`);
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

/**
 * One line, and only when something actually happened. A hygiene task that
 * announces itself on every run trains people to ignore it, and the counts
 * are the only part with diagnostic value: which fixture domains leaked, and
 * how many namespaces were involved. Never logs an email, a marker, a token,
 * or a connection string — the namespace ids are opaque per-run identifiers,
 * and they are what makes a leak traceable to the run that caused it.
 */
function report(
  label: string,
  what: string,
  result: StaleFixtureSweepResult,
): void {
  if (result.namespaces.length === 0) {
    return;
  }

  const counts = Object.entries(result.counts)
    .filter(([, count]) => count > 0)
    .map(([domain, count]) => `${domain}=${count}`)
    .join(' ');

  if (!counts) {
    return;
  }

  console.warn(
    `${LOG_PREFIX} ${label}: reclaimed ${result.namespaces.length} fixture ` +
      `namespace(s) ${what} [${result.namespaces.join(',')}] -> ${counts}`,
  );
}

/**
 * The message only. An `Error` from Prisma can carry a rendered query in its
 * `stack`, and the guard's own messages are already redacted, so the message
 * is both the useful part and the safe part.
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
