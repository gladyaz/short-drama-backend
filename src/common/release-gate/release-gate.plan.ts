/**
 * WHAT THE GATE RUNS, declared as data.
 *
 * Kept out of `scripts/release-gate.ts` so that the LIST of checks is
 * something a test can assert on, a document can render, and a reviewer can
 * read in one screen — rather than something that has to be reconstructed by
 * following an imperative script. The script below it is then only execution
 * and presentation, which is the same split `production-preflight` already
 * uses (rules in `src/`, exit code in `scripts/`).
 */

/**
 * The focused, DATABASE-FREE production-configuration suites.
 *
 * WHY A CURATED LIST RATHER THAN THE WHOLE UNIT SUITE. Over a third of this
 * repository's unit suites (53 of 137 at the time of writing) talk to
 * Postgres — they are integration tests
 * wearing a `.spec.ts` extension, by this repo's long-standing precedent. A
 * release gate must not require a database (see `migration-consistency.ts`
 * for why connecting to an ambient one is worse than not connecting at all),
 * so the gate runs the suites that grade CONFIGURATION AND POLICY, which are
 * pure by construction, and leaves the database-backed ones to the opt-in
 * full-suite step and to CI's throwaway Postgres.
 *
 * These are Jest `--testPathPatterns` values, matched against the full path.
 */
export const FOCUSED_PRODUCTION_CONFIG_SPECS: readonly string[] = [
  'src/config/env\\.validation\\.spec\\.ts',
  'src/config/configuration\\.spec\\.ts',
  'src/config/v1-integration\\.spec\\.ts',
  'src/common/production-preflight/preflight\\.spec\\.ts',
  'src/common/release-gate/.*\\.spec\\.ts',
  'src/rewards/social-missions\\.constants\\.spec\\.ts',
  'src/rewards/rewards\\.constants\\.spec\\.ts',
  'src/auth/identity/whatsapp/whatsapp-provider\\.factory\\.spec\\.ts',
];

/**
 * The focused HLS regression suites.
 *
 * Chosen to cover exactly the contract a release must not silently break:
 *
 *   master/variant playlist shape   master-playlist.service, hls-package-validator
 *   the rendition ladder            rendition-ladder  (incl. "never invent a
 *                                   rung above the source" — the no-forced-1080p
 *                                   property)
 *   playback authorisation          hls-playback-token.util, hls-token-contract
 *   R2 precedence + safe URLs       playback-source.util, storage.service,
 *                                   video-response.util
 *   module wiring                   hls.module, transcode.module, transcode.constants
 *
 * Every one is database-free. The database-backed HLS suites (the demote CLI,
 * the transcode lifecycle services) run in the opt-in full-suite step; the
 * structural half of "the CLIs are still intact" is covered without a
 * database by `HLS_OPERATIONAL_ENTRYPOINTS` below.
 *
 * NOTHING HERE TOUCHES MEDIA. No ffmpeg is invoked, no bucket is read, and no
 * job is enqueued — these are unit suites over pure functions and fakes.
 */
export const HLS_REGRESSION_SPECS: readonly string[] = [
  'src/transcode/hls/master-playlist\\.service\\.spec\\.ts',
  'src/transcode/hls/rendition-ladder\\.spec\\.ts',
  'src/transcode/hls/hls-playback-token\\.util\\.spec\\.ts',
  'src/transcode/hls/hls-token-contract\\.spec\\.ts',
  'src/transcode/hls/hls-package-validator\\.service\\.spec\\.ts',
  'src/transcode/hls/hls\\.module\\.spec\\.ts',
  'src/transcode/hls-staging-key\\.util\\.spec\\.ts',
  'src/transcode/transcode\\.constants\\.spec\\.ts',
  'src/transcode/transcode\\.module\\.spec\\.ts',
  'src/videos/playback-source\\.util\\.spec\\.ts',
  'src/videos/video-response\\.util\\.spec\\.ts',
  'src/storage/storage\\.service\\.spec\\.ts',
];

/**
 * The media/HLS operational CLIs, and the npm script each is reached by.
 *
 * A RELEASE MUST NOT SILENTLY LOSE ONE. These are the only tools that can
 * migrate media into R2, run a transcode wave, or DEMOTE an HLS row back to
 * its source when a gateway turns out to be broken — the last of which is the
 * only rollback path HLS has (there is no generation history to revert to).
 * Losing the demote CLI in a refactor would not fail a single test; it would
 * simply not be noticed until the day it was needed.
 *
 * The check is structural and read-only: the npm script must still exist and
 * must still point at a file that exists. NOTHING IS EXECUTED — running any
 * of these would enqueue work, mutate rows or write to a bucket.
 */
export const HLS_OPERATIONAL_ENTRYPOINTS: ReadonlyArray<{
  readonly script: string;
  readonly file: string;
  readonly why: string;
}> = [
  {
    script: 'hls:demote',
    file: 'scripts/hls-demote.ts',
    why: 'the only rollback path for an HLS row whose gateway or package is broken',
  },
  {
    script: 'hls:wave-enqueue',
    file: 'scripts/hls-wave-enqueue.ts',
    why: 'enqueues a transcode wave',
  },
  {
    script: 'media:r2-migrate',
    file: 'scripts/run-r2-media-migration.ts',
    why: 'migrates local media into object storage',
  },
  {
    script: 'production:preflight',
    file: 'scripts/production-preflight.ts',
    why: 'the configuration verdict this gate embeds',
  },
  {
    script: 'smoke:production',
    file: 'scripts/production-smoke-test.ts',
    why: 'the only tool that verifies a DEPLOYED origin — the step after this gate',
  },
];

/**
 * Every check the gate performs, in run order.
 *
 * `alwaysRuns: false` marks a step that can legitimately report SKIPPED —
 * and every one of those is skipped for the same reason: it would need a
 * database, and the gate refuses to pick one for you.
 */
export interface ReleaseGateStepDescriptor {
  readonly id: string;
  readonly title: string;
  readonly alwaysRuns: boolean;
  /** One line, for `--list` and for the docs table. */
  readonly what: string;
}

export const RELEASE_GATE_STEPS: readonly ReleaseGateStepDescriptor[] = [
  {
    id: 'build',
    title: 'Build (typecheck + compile)',
    alwaysRuns: true,
    what: 'npm run build — the same compile CI gates on.',
  },
  {
    id: 'lint',
    title: 'Lint (verify only)',
    alwaysRuns: true,
    what: 'npm run lint:ci — never the --fix variant, so the gate cannot edit the tree.',
  },
  {
    id: 'test:config',
    title: 'Focused production-config tests',
    alwaysRuns: true,
    what: 'The database-free suites that grade the boot contract, the preflight and V1 policy.',
  },
  {
    id: 'test:hls',
    title: 'HLS regression tests',
    alwaysRuns: true,
    what: 'Playlist contract, rendition ladder, playback tokens, R2 precedence and safe URLs.',
  },
  {
    id: 'hls:entrypoints',
    title: 'HLS/media operational CLIs intact',
    alwaysRuns: true,
    what: 'Structural: every operational npm script still resolves to a file that exists.',
  },
  {
    id: 'test:full',
    title: 'Full unit suite',
    alwaysRuns: false,
    what: 'Opt-in (--with-db-tests): 53 suites need Postgres, so the gate never runs it uninvited.',
  },
  {
    id: 'prisma:validate',
    title: 'Prisma schema validation',
    alwaysRuns: true,
    what: 'npx prisma validate — parses the schema. Opens no connection.',
  },
  {
    id: 'prisma:history',
    title: 'Migration history consistency',
    alwaysRuns: true,
    what: 'Offline: every migration has non-empty SQL, timestamps increase, provider agrees.',
  },
  {
    id: 'prisma:status',
    title: 'Migration status vs target database',
    alwaysRuns: false,
    what: 'Opt-in (RELEASE_GATE_DATABASE_URL): read-only `prisma migrate status`.',
  },
  {
    id: 'preflight',
    title: 'Production preflight',
    alwaysRuns: true,
    what: 'The full runProductionPreflight verdict over this mode’s configuration.',
  },
  {
    id: 'contract',
    title: 'V1 feature contract',
    alwaysRuns: true,
    what: 'Google, WhatsApp, Rewards, required social missions, free catalog, payments off.',
  },
  {
    id: 'leak-scan',
    title: 'Release leak scan',
    alwaysRuns: true,
    what: 'Classified scan of release-bound source and CI for dev artefacts and hardcoded credentials.',
  },
];
