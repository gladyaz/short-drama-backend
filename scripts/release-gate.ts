/**
 * RED PANDA V1 — FINAL RELEASE GATE.
 *
 *   npm run release:gate                 # CI / structural (the default)
 *   npm run release:gate -- --mode=local
 *   npm run release:gate -- --mode=production
 *
 * ONE DETERMINISTIC, READ-ONLY COMMAND an engineer runs before a staging or
 * production deployment. It is the middle of the three-step release timeline
 * this repository already had two ends of:
 *
 *   npm run release:gate      ->  deploy  ->  npm run smoke:production
 *   judges the CODE and the       the only   proves a live origin actually
 *   CONFIGURATION, offline        step that  serves bytes
 *                                 changes
 *                                 anything
 *
 * WHAT IT WILL NEVER DO. It does not deploy, push, migrate, seed, enqueue a
 * job, write to R2 or Redis, or send a WhatsApp message. It connects to a
 * database ONLY when one is named explicitly in `RELEASE_GATE_DATABASE_URL`,
 * and even then only to READ `prisma migrate status`. Every step is either a
 * pure function over an environment record, a read of a file, or one of the
 * repository's own `build` / `lint:ci` / `jest` commands.
 *
 * IT NEVER PRINTS A SECRET. Findings name variables and echo only values that
 * are public by nature — flags, URLs, hostnames. The leak scan deliberately
 * prints a variable NAME and never the literal it found.
 *
 * IT NEVER FABRICATES A PASS. A check that could not run reports SKIPPED,
 * with the reason, in its own section, and again in the verdict line. The
 * exit code answers exactly one question — did anything BLOCK — and the text
 * beside it says what a clean run did and did not prove.
 *
 * Exit codes:  0 = no blockers (warnings and skips may still be present)
 *              1 = at least one blocker
 *              2 = the gate itself could not run (bad arguments)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { runProductionPreflight } from '../src/common/production-preflight/preflight';
import {
  checkMigrationHistory,
  interpretMigrateStatus,
  MigrationDirectory,
  parseLockProvider,
  parseSchemaProvider,
  skippedMigrationStatus,
} from '../src/common/release-gate/migration-consistency';
import {
  FOCUSED_PRODUCTION_CONFIG_SPECS,
  HLS_OPERATIONAL_ENTRYPOINTS,
  HLS_REGRESSION_SPECS,
} from '../src/common/release-gate/release-gate.plan';
import {
  printHeader,
  printPlan,
  printStep,
  printVerdict,
} from '../src/common/release-gate/release-gate.report';
import {
  GateFinding,
  GateSeverity,
  GateStepResult,
  summarise,
} from '../src/common/release-gate/release-gate.types';
import {
  isReleaseGateMode,
  RELEASE_GATE_MODES,
  ReleaseGateMode,
  ReleaseModeResolution,
  resolveReleaseGateMode,
  STRUCTURAL_DATABASE_URL,
} from '../src/common/release-gate/release-mode';
import {
  classifyPath,
  LeakScanInput,
  runLeakScan,
  SCANNED_FILE_CLASSES,
} from '../src/common/release-gate/secret-leak-scan';
import { checkV1FeatureContract } from '../src/common/release-gate/v1-feature-contract';

const REPO_ROOT = join(__dirname, '..');

interface CliOptions {
  mode: ReleaseGateMode;
  withDbTests: boolean;
  list: boolean;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: readonly string[]): CliOptions | string {
  let mode: ReleaseGateMode = 'ci';
  let withDbTests = false;
  let list = false;

  for (const arg of argv) {
    if (arg === '--list') {
      list = true;
      continue;
    }
    if (arg === '--with-db-tests') {
      withDbTests = true;
      continue;
    }
    if (arg.startsWith('--mode=')) {
      const value = arg.slice('--mode='.length);
      if (!isReleaseGateMode(value)) {
        return `Unknown --mode=${value}. Expected one of: ${RELEASE_GATE_MODES.join(', ')}.`;
      }
      mode = value;
      continue;
    }
    return `Unknown argument ${JSON.stringify(arg)}.`;
  }

  return { mode, withDbTests, list };
}

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

interface CommandOutcome {
  exitCode: number;
  output: string;
}

/**
 * Runs a command and captures BOTH streams and the real exit code.
 *
 * `spawnSync` rather than a shell pipeline on purpose: piping a command into
 * `tail` yields TAIL'S exit code, which is how a red build reports itself as
 * green. A gate that got that wrong would be worse than no gate.
 */
function runCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): CommandOutcome {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  if (result.error) {
    return { exitCode: 127, output: `${output}\n${result.error.message}` };
  }

  return { exitCode: result.status ?? 1, output };
}

/** The last few lines of a command's output, for a failure finding. */
function tailOf(output: string, lines = 12): string {
  return output
    .trimEnd()
    .split('\n')
    .slice(-lines)
    .map((line) => `      | ${line}`)
    .join('\n');
}

function commandStep(
  id: string,
  title: string,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  onFailure: string,
): GateStepResult {
  const startedAt = Date.now();
  const { exitCode, output } = runCommand(command, args, env);
  const durationMs = Date.now() - startedAt;

  if (exitCode === 0) {
    return {
      id,
      title,
      durationMs,
      findings: [
        {
          severity: 'PASS',
          check: id,
          detail: `${[command, ...args].join(' ')} exited 0.`,
        },
      ],
    };
  }

  return {
    id,
    title,
    durationMs,
    findings: [
      {
        severity: 'BLOCKER',
        check: id,
        detail:
          `${[command, ...args].join(' ')} exited ${exitCode}. ${onFailure}\n` +
          tailOf(output),
      },
    ],
  };
}

/**
 * The environment handed to every SUBPROCESS.
 *
 * NOT THE SAME THING AS THE ENVIRONMENT BEING GRADED, and conflating the two
 * is a real bug this function exists to prevent.
 *
 * `--mode=production` is run with the candidate posture exported — including
 * `NODE_ENV=production`. Jest only defaults `NODE_ENV` to `test` when it is
 * UNSET, so without the pin below the focused suites would run under
 * `production` in that mode and under `test` in the other two. Several of
 * them assert on rules that key on the exact string `production` (the
 * dev-tools allowlist, the fake-OTP-driver refusal), so the same commit could
 * produce different subprocess results depending on which mode was asked
 * for — from a gate whose entire value is being deterministic.
 *
 * So: `NODE_ENV=test` is PINNED for every subprocess. Whether the CANDIDATE
 * says `production` is graded in-process, by the preflight and the feature
 * contract, over `resolution.env` — never by what a test run happened to
 * inherit.
 *
 * `DATABASE_URL` is defaulted rather than overridden: `prisma.config.ts`
 * throws when the variable is absent, and the `--with-db-tests` step needs
 * whatever real database the operator has chosen.
 */
function subprocessEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: process.env.DATABASE_URL ?? STRUCTURAL_DATABASE_URL,
  };
}

/**
 * The environment for the DATABASE-BACKED suite, which is the one step that
 * genuinely needs a reachable Postgres.
 *
 * It takes the URL as an argument rather than falling back to
 * `STRUCTURAL_DATABASE_URL` like `subprocessEnv` does. That fallback is right
 * for schema parsing and for suites that never connect; handing it to a suite
 * that DOES connect just runs 53 suites against a hostname guaranteed never
 * to resolve and reports the resulting wall of failures as a release blocker.
 *
 * It also never reads `RELEASE_GATE_DATABASE_URL`. That variable names the
 * database the read-only `migrate status` check inspects — which may well be
 * staging — and a test suite writes fixtures.
 */
function databaseBackedTestEnv(databaseUrl: string): NodeJS.ProcessEnv {
  return { ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl };
}

function jestStep(
  id: string,
  title: string,
  patterns: readonly string[],
  what: string,
): GateStepResult {
  return commandStep(
    id,
    title,
    'npx',
    ['jest', '--silent', `--testPathPatterns=(${patterns.join('|')})`],
    subprocessEnv(),
    what,
  );
}

// ---------------------------------------------------------------------------
// Inline (in-process) steps
// ---------------------------------------------------------------------------

function inlineStep(
  id: string,
  title: string,
  run: () => GateFinding[],
): GateStepResult {
  const startedAt = Date.now();
  const findings = run();
  return { id, title, findings, durationMs: Date.now() - startedAt };
}

/**
 * The operational CLIs, checked structurally. Reads `package.json` and the
 * filesystem; executes nothing.
 */
function checkOperationalEntrypoints(): GateFinding[] {
  const findings: GateFinding[] = [];
  const pkg = JSON.parse(
    readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as { scripts?: Record<string, string> };
  const scripts = pkg.scripts ?? {};

  const missing: string[] = [];

  for (const entry of HLS_OPERATIONAL_ENTRYPOINTS) {
    const script = scripts[entry.script];

    if (script === undefined) {
      missing.push(entry.script);
      findings.push({
        severity: 'BLOCKER',
        check: `entrypoint ${entry.script}`,
        detail:
          `package.json has no "${entry.script}" script. It is ${entry.why}, ` +
          'and losing it fails no test — it is simply not there the day it is needed.',
      });
      continue;
    }

    if (!existsSync(join(REPO_ROOT, entry.file))) {
      missing.push(entry.script);
      findings.push({
        severity: 'BLOCKER',
        check: `entrypoint ${entry.script}`,
        detail:
          `npm run ${entry.script} points at ${entry.file}, which does not ` +
          `exist. It is ${entry.why}.`,
      });
    }
  }

  if (missing.length === 0) {
    findings.push({
      severity: 'PASS',
      check: 'operational entrypoints',
      detail:
        `All ${HLS_OPERATIONAL_ENTRYPOINTS.length} media/HLS operational CLIs ` +
        'still resolve to files that exist. None was executed.',
    });
  }

  return findings;
}

/** Reads `prisma/migrations` and grades it. No connection. */
function checkMigrations(): GateFinding[] {
  const migrationsDir = join(REPO_ROOT, 'prisma', 'migrations');

  if (!existsSync(migrationsDir)) {
    return [
      {
        severity: 'BLOCKER',
        check: 'migration history',
        detail: 'prisma/migrations does not exist.',
      },
    ];
  }

  const directories: MigrationDirectory[] = readdirSync(migrationsDir)
    .filter((name) => statSync(join(migrationsDir, name)).isDirectory())
    .sort()
    .map((name) => {
      const sqlPath = join(migrationsDir, name, 'migration.sql');
      const hasMigrationSql = existsSync(sqlPath);
      return {
        name,
        hasMigrationSql,
        sqlByteLength: hasMigrationSql ? statSync(sqlPath).size : 0,
      };
    });

  const lockPath = join(migrationsDir, 'migration_lock.toml');
  const lockProvider = existsSync(lockPath)
    ? parseLockProvider(readFileSync(lockPath, 'utf8'))
    : null;

  const schemaPath = join(REPO_ROOT, 'prisma', 'schema.prisma');
  const schemaProvider = existsSync(schemaPath)
    ? parseSchemaProvider(readFileSync(schemaPath, 'utf8'))
    : null;

  return checkMigrationHistory({ directories, lockProvider, schemaProvider });
}

/**
 * `prisma migrate status`, but ONLY against a database the operator named.
 *
 * The ambient `DATABASE_URL` is never used here — see
 * `migration-consistency.ts` for why a confident answer about the wrong
 * database is worse than no answer.
 */
function checkMigrationStatus(): GateFinding[] {
  const target = process.env.RELEASE_GATE_DATABASE_URL;

  if (!target || target.trim().length === 0) {
    return [skippedMigrationStatus()];
  }

  const { exitCode, output } = runCommand(
    'npx',
    ['prisma', 'migrate', 'status'],
    { ...process.env, DATABASE_URL: target },
  );

  return [interpretMigrateStatus(exitCode, output)];
}

/**
 * Walks the repository's tracked-source directories and runs the leak scan.
 *
 * `git ls-files` is deliberately NOT used: the gate must work in an exported
 * tree with no git directory, and it must never depend on the index being
 * clean. Walking the filesystem and filtering by file class gives the same
 * answer with fewer assumptions.
 */
function collectScannableFiles(): LeakScanInput[] {
  const roots = ['src', 'scripts', 'prisma', 'workers', '.github'];
  const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.git', 'build']);
  const READABLE = /\.(ts|js|mjs|cjs|ya?ml|sql|json)$/i;

  const files: LeakScanInput[] = [];

  const walk = (absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) {
          continue;
        }
        walk(join(absolute, entry.name));
        continue;
      }

      if (!READABLE.test(entry.name)) {
        continue;
      }

      const path = relative(REPO_ROOT, join(absolute, entry.name))
        .split(sep)
        .join('/');

      if (!SCANNED_FILE_CLASSES.includes(classifyPath(path))) {
        continue;
      }

      files.push({
        path,
        content: readFileSync(join(absolute, entry.name), 'utf8'),
      });
    }
  };

  for (const root of roots) {
    const absolute = join(REPO_ROOT, root);
    if (existsSync(absolute)) {
      walk(absolute);
    }
  }

  return files;
}

/**
 * The preflight verdict, re-expressed in gate severities.
 *
 * In `local` mode every BLOCKER is downgraded to a WARNING, for the same
 * reason the feature contract is advisory there: a laptop is not a release
 * candidate, and a gate that is always red on a developer's machine is a gate
 * they stop reading.
 */
function preflightFindings(resolution: ReleaseModeResolution): GateFinding[] {
  const report = runProductionPreflight(resolution.env);
  const downgrade = resolution.policyEnforcement === 'advisory';

  return report.findings.map((finding) => ({
    severity: (downgrade && finding.severity === 'BLOCKER'
      ? 'WARNING'
      : finding.severity) satisfies GateSeverity,
    check: `preflight: ${finding.check}`,
    detail: finding.detail,
  }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * The one place this script writes to stdout. Passed into the report
 * functions so they stay pure enough to unit test; failures still go to
 * stderr directly, where a shell expects them.
 */
const emit = (line: string): void => {
  console.log(line);
};

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));

  if (typeof parsed === 'string') {
    console.error(`release:gate — ${parsed}`);
    console.error(
      'Usage: npm run release:gate -- [--mode=ci|local|production] [--with-db-tests] [--list]',
    );
    process.exitCode = 2;
    return;
  }

  if (parsed.list) {
    printPlan(emit);
    return;
  }

  // LOCAL and PRODUCTION grade the ambient environment. `dotenv` is loaded
  // for LOCAL only: a developer keeps their posture in `.env`, whereas a
  // production candidate must be supplied explicitly — silently absorbing a
  // developer's `.env` into a production verdict is exactly the mistake
  // `scripts/production-preflight.ts` refuses to make.
  if (parsed.mode === 'local') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('dotenv/config');
  }

  // ------------------------------------------------------------------
  // `--with-db-tests` PRECONDITIONS, checked before anything runs.
  //
  // Both refusals are safety rules, not conveniences:
  //
  //   PRODUCTION IS REFUSED OUTRIGHT. In that mode the ambient environment is
  //   a real candidate posture, so `DATABASE_URL` is the REAL DATABASE. The
  //   unit suite creates and deletes fixture rows. There is no version of
  //   "grade my production configuration" that should also mean "write test
  //   users into it".
  //
  //   AN ABSENT `DATABASE_URL` IS REFUSED rather than defaulted, for the same
  //   reason the migration-status check refuses to guess: the gate does not
  //   pick a database for you. Exiting 2 says the gate could not run as
  //   asked, which is true — as opposed to a blocker, which would claim the
  //   RELEASE is bad when it is the invocation that was.
  // ------------------------------------------------------------------
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (parsed.withDbTests && parsed.mode === 'production') {
    console.error(
      'release:gate — refusing --with-db-tests in --mode=production.\n' +
        'In that mode DATABASE_URL is the real candidate database, and the ' +
        'unit suite writes and deletes fixture rows in it. Run the ' +
        'database-backed suites against a disposable database with ' +
        '--mode=local, and grade the production configuration separately.',
    );
    process.exitCode = 2;
    return;
  }

  if (parsed.withDbTests && !databaseUrl) {
    console.error(
      'release:gate — --with-db-tests needs a DATABASE_URL, and this gate ' +
        'will not choose one for you.\n' +
        'Export a DISPOSABLE database (or run --mode=local so your .env is ' +
        'loaded). RELEASE_GATE_DATABASE_URL is deliberately not used here: ' +
        'it names the database the read-only migration-status check inspects, ' +
        'which may be staging, and a test suite writes to what it is given.',
    );
    process.exitCode = 2;
    return;
  }

  const resolution = resolveReleaseGateMode(parsed.mode, process.env);

  printHeader(resolution, emit);

  const steps: GateStepResult[] = [];
  const record = (step: GateStepResult): void => {
    steps.push(step);
    printStep(step, emit);
  };

  record(
    commandStep(
      'build',
      'Build (typecheck + compile)',
      'npm',
      ['run', 'build'],
      subprocessEnv(),
      'The release does not compile.',
    ),
  );

  record(
    commandStep(
      'lint',
      'Lint (verify only)',
      'npm',
      ['run', 'lint:ci'],
      subprocessEnv(),
      'Lint failed. The gate deliberately runs lint:ci, never the --fix variant.',
    ),
  );

  record(
    jestStep(
      'test:config',
      'Focused production-config tests',
      FOCUSED_PRODUCTION_CONFIG_SPECS,
      'The boot contract, preflight or V1 policy suites failed.',
    ),
  );

  record(
    jestStep(
      'test:hls',
      'HLS regression tests',
      HLS_REGRESSION_SPECS,
      'An HLS contract suite failed — playlist shape, ladder, token or R2 precedence.',
    ),
  );

  record(
    inlineStep(
      'hls:entrypoints',
      'HLS/media operational CLIs intact',
      checkOperationalEntrypoints,
    ),
  );

  if (parsed.withDbTests) {
    record(
      commandStep(
        'test:full',
        'Full unit suite (--with-db-tests)',
        'npm',
        ['test'],
        databaseBackedTestEnv(databaseUrl!),
        'The full unit suite failed against the database named by ' +
          'DATABASE_URL. Over a third of its suites connect to Postgres.',
      ),
    );
  } else {
    record({
      id: 'test:full',
      title: 'Full unit suite',
      durationMs: 0,
      findings: [
        {
          severity: 'SKIPPED',
          check: 'full unit suite',
          detail:
            'Over a third of this repository’s unit suites (53 of 137 at the ' +
            'time of writing) talk to Postgres, so ' +
            'running them uninvited would write fixtures into whatever ' +
            'database the ambient DATABASE_URL names — which on a developer ' +
            'machine is the shared local dev database. Pass --with-db-tests ' +
            'to run them against a database you have chosen. CI runs them in ' +
            'its own job against a throwaway Postgres.',
        },
      ],
    });
  }

  record(
    commandStep(
      'prisma:validate',
      'Prisma schema validation',
      'npx',
      ['prisma', 'validate'],
      subprocessEnv(),
      'prisma/schema.prisma is not a valid schema.',
    ),
  );

  record(
    inlineStep(
      'prisma:history',
      'Migration history consistency',
      checkMigrations,
    ),
  );

  record(
    inlineStep(
      'prisma:status',
      'Migration status vs target database',
      checkMigrationStatus,
    ),
  );

  record(
    inlineStep('preflight', 'Production preflight', () =>
      preflightFindings(resolution),
    ),
  );

  record(
    inlineStep('contract', 'V1 feature contract', () =>
      checkV1FeatureContract(resolution.env, resolution.policyEnforcement),
    ),
  );

  record(
    inlineStep(
      'leak-scan',
      'Release leak scan',
      () => runLeakScan(collectScannableFiles()).findings,
    ),
  );

  const report = summarise(steps);
  printVerdict(report, resolution, emit);

  if (!report.ok) {
    process.exitCode = 1;
  }
}

main();
