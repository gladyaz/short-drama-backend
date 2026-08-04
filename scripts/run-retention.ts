import 'dotenv/config';
import { runRetentionCli } from '../src/retention/run-retention-cli';

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
 * `NODE_ENV` — `env.validation.ts`'s own check is now also allowlist-shaped,
 * since Phase 12, work unit 12D-B2, commit `7cfd411`; the two are
 * independent gates for two different surfaces — dev-tools boot vs. this
 * destructive retention run — and neither is implemented in terms of the
 * other), AND (2) `DATABASE_URL` must resolve to the SAME database as
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
 *
 * Phase 13, work unit 13A-B1 (closes `TASK_QUEUE.md` follow-up item 22):
 * the actual `--commit` implementation now lives in
 * `../src/retention/run-retention-cli.ts` (`runRetentionCli`), which runs
 * the safety gate above BEFORE `PrismaService` is constructed or
 * `$connect()` is called at all — not merely before the first Prisma
 * *query*, as was true previously. A refusal here now means literally zero
 * database activity for the run, including the connection handshake itself
 * — see that file's doc comment for the full before/after and this work
 * unit's regression test for the mutation-tested proof. This entry point is
 * deliberately just a thin wrapper (`.env` loading + the `runRetentionCli`
 * call below) so that file — not this one — is what actually orders the
 * gate before construction.
 */
runRetentionCli(process.argv).catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
