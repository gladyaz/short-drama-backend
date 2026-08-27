/**
 * MIGRATION SAFETY, READ-ONLY — "will the database this release expects
 * actually exist when the release starts?"
 *
 * `start:migrate:prod` runs `prisma migrate deploy && node dist/main`, so a
 * migration problem does not surface as a bad report — it surfaces as a
 * deployment that has already replaced the running one and cannot boot. The
 * checks here are the cheap version of finding that out.
 *
 * WHAT IT WILL NOT DO, IN ANY MODE:
 *
 *   - apply, resolve, reset or generate a migration;
 *   - write one byte to any database;
 *   - connect to a database that was not EXPLICITLY handed to it. The ambient
 *     `DATABASE_URL` is deliberately ignored. A release gate that quietly
 *     connected to whatever was exported in the operator's shell would, on a
 *     developer laptop, be pointing at the shared local dev database — and
 *     `prisma migrate status` against the wrong database is worse than no
 *     answer, because it is a confident one.
 *
 * So the DB-backed checks are opt-in through `RELEASE_GATE_DATABASE_URL`, and
 * when it is absent they report SKIPPED with the reason. They never report a
 * pass they did not earn.
 *
 * THE OFFLINE CHECKS BELOW NEED NO DATABASE AT ALL and always run: they are
 * properties of the migration FOLDER, and a folder can be wrong in ways that
 * only show up on a fresh database — which staging always is.
 */
import { GateFinding } from './release-gate.types';

/** One directory under `prisma/migrations`, as read from disk by the CLI. */
export interface MigrationDirectory {
  /** Directory name, e.g. `20260826140000_add_v1_reward_missions_and_perks`. */
  readonly name: string;
  readonly hasMigrationSql: boolean;
  /** Byte length of `migration.sql`, or 0 when absent. */
  readonly sqlByteLength: number;
}

export interface MigrationHistoryInput {
  readonly directories: readonly MigrationDirectory[];
  /** `provider` from `prisma/migrations/migration_lock.toml`, or null if unreadable. */
  readonly lockProvider: string | null;
  /** `provider` from the `datasource` block of `prisma/schema.prisma`, or null. */
  readonly schemaProvider: string | null;
}

/** `20260826140000_add_v1_reward_missions_and_perks` -> `20260826140000`. */
const TIMESTAMP_PREFIX = /^(\d{14})_[A-Za-z0-9_]+$/;

/**
 * Grades the migration FOLDER. Pure — it is handed a directory listing rather
 * than reading one, so every failure shape is testable without creating
 * files.
 */
export function checkMigrationHistory(
  input: MigrationHistoryInput,
): GateFinding[] {
  const findings: GateFinding[] = [];
  const { directories, lockProvider, schemaProvider } = input;

  if (directories.length === 0) {
    findings.push({
      severity: 'BLOCKER',
      check: 'migration history',
      detail:
        'prisma/migrations contains no migration. `prisma migrate deploy` ' +
        'would create an empty database and the process would fail on its ' +
        'first query.',
    });
    return findings;
  }

  // ------------------------------------------------------------------
  // A migration directory with no `migration.sql`, or an empty one, is
  // silently a NO-OP: `migrate deploy` records it as applied and moves on,
  // so the datamodel and the database disagree from then on with nothing
  // anywhere reporting it.
  // ------------------------------------------------------------------
  const missingSql = directories.filter((dir) => !dir.hasMigrationSql);
  const emptySql = directories.filter(
    (dir) => dir.hasMigrationSql && dir.sqlByteLength === 0,
  );

  for (const dir of missingSql) {
    findings.push({
      severity: 'BLOCKER',
      check: 'migration file missing',
      detail:
        `prisma/migrations/${dir.name} has no migration.sql. It would be ` +
        'recorded as applied while changing nothing, leaving the database ' +
        'permanently behind the datamodel.',
    });
  }

  for (const dir of emptySql) {
    findings.push({
      severity: 'BLOCKER',
      check: 'migration file empty',
      detail:
        `prisma/migrations/${dir.name}/migration.sql is empty. It would be ` +
        'recorded as applied while changing nothing.',
    });
  }

  // ------------------------------------------------------------------
  // NAME SHAPE AND ORDER. Prisma applies migrations in lexicographic
  // directory order. A directory whose timestamp is EARLIER than one before
  // it applies in a different relative order on a fresh database than the
  // one it was authored in — which is exactly what staging is, and exactly
  // what a developer's already-migrated database will never reveal.
  // ------------------------------------------------------------------
  const malformed = directories.filter(
    (dir) => !TIMESTAMP_PREFIX.test(dir.name),
  );

  for (const dir of malformed) {
    findings.push({
      severity: 'WARNING',
      check: 'migration name shape',
      detail:
        `prisma/migrations/${dir.name} is not <14-digit-timestamp>_<name>. ` +
        'Ordering is lexicographic, so a non-standard name applies in an ' +
        'order nobody chose.',
    });
  }

  const timestamps = directories
    .map((dir) => TIMESTAMP_PREFIX.exec(dir.name)?.[1])
    .filter((value): value is string => value !== undefined);

  const outOfOrder: string[] = [];
  for (let i = 1; i < timestamps.length; i += 1) {
    if (timestamps[i] <= timestamps[i - 1]) {
      outOfOrder.push(`${directories[i - 1].name} -> ${directories[i].name}`);
    }
  }

  if (outOfOrder.length > 0) {
    findings.push({
      severity: 'BLOCKER',
      check: 'migration ordering',
      detail:
        'Migration timestamps do not increase monotonically: ' +
        `${outOfOrder.join('; ')}. On a fresh database these apply in a ` +
        'different relative order than they did on the machine that ' +
        'authored them.',
    });
  }

  // ------------------------------------------------------------------
  // PROVIDER AGREEMENT. `migration_lock.toml` is what stops a Postgres
  // history being replayed against a different engine. A mismatch here means
  // the recorded SQL dialect is not the one the schema targets.
  // ------------------------------------------------------------------
  if (lockProvider === null) {
    findings.push({
      severity: 'BLOCKER',
      check: 'migration lock',
      detail:
        'prisma/migrations/migration_lock.toml is missing or has no ' +
        'provider. Prisma uses it to refuse replaying a history against a ' +
        'different database engine.',
    });
  } else if (schemaProvider === null) {
    findings.push({
      severity: 'WARNING',
      check: 'migration lock',
      detail:
        `migration_lock.toml declares provider "${lockProvider}", but the ` +
        'datasource provider could not be read from prisma/schema.prisma to ' +
        'compare it against.',
    });
  } else if (lockProvider !== schemaProvider) {
    findings.push({
      severity: 'BLOCKER',
      check: 'migration lock',
      detail:
        `migration_lock.toml declares provider "${lockProvider}" but ` +
        `prisma/schema.prisma targets "${schemaProvider}". The recorded SQL ` +
        'is for a different engine than the one this release will run on.',
    });
  } else {
    findings.push({
      severity: 'PASS',
      check: 'migration lock',
      detail: `Provider "${lockProvider}" agrees between migration_lock.toml and schema.prisma.`,
    });
  }

  if (
    missingSql.length === 0 &&
    emptySql.length === 0 &&
    outOfOrder.length === 0
  ) {
    findings.push({
      severity: 'PASS',
      check: 'migration history',
      detail:
        `${directories.length} migration(s), each with a non-empty ` +
        'migration.sql, in strictly increasing timestamp order.',
    });
  }

  return findings;
}

/**
 * The exit status of `prisma migrate status`, turned into a finding.
 *
 * `migrate status` is READ-ONLY: it reads `_prisma_migrations` and compares
 * it against the folder. It applies nothing.
 *
 * IT IS ONLY EVER RUN AGAINST A DATABASE THE OPERATOR NAMED, through
 * `RELEASE_GATE_DATABASE_URL`. The messages below therefore always name that
 * variable rather than `DATABASE_URL`, so a reader can never be confused
 * about which database was actually consulted.
 */
export function interpretMigrateStatus(
  exitCode: number,
  output: string,
): GateFinding {
  const text = output.toLowerCase();

  if (text.includes('database schema is up to date')) {
    return {
      severity: 'PASS',
      check: 'migration status',
      detail:
        'Every migration in prisma/migrations is already applied to the ' +
        'database named by RELEASE_GATE_DATABASE_URL. Nothing was applied by ' +
        'this check.',
    };
  }

  if (text.includes('have not yet been applied')) {
    // NOT A BLOCKER, DELIBERATELY, and this is the one judgement call in
    // this file. `start:migrate:prod` runs `prisma migrate deploy` as its
    // FIRST act, so pending migrations are the NORMAL state of a target
    // database immediately before a release — blocking on it would refuse
    // every deployment that actually ships a schema change. What the
    // operator needs is to SEE the list, and to have decided that applying
    // it is safe (docs/V1_STAGING_RUNBOOK.md §5).
    return {
      severity: 'WARNING',
      check: 'migration status',
      detail:
        'The database named by RELEASE_GATE_DATABASE_URL has migrations ' +
        'pending. This is expected before a release that ships a schema ' +
        'change — `prisma migrate deploy` applies them at start-up. Confirm ' +
        'against docs/V1_STAGING_RUNBOOK.md §5 that every pending migration ' +
        'is additive before deploying. Nothing was applied by this check.',
    };
  }

  if (
    text.includes('failed migration') ||
    text.includes('following migration have failed') ||
    text.includes('following migrations have failed')
  ) {
    return {
      severity: 'BLOCKER',
      check: 'migration status',
      detail:
        'The database named by RELEASE_GATE_DATABASE_URL has a FAILED ' +
        'migration recorded. `prisma migrate deploy` refuses to proceed past ' +
        'one, so the release would start, fail to migrate, and not boot. ' +
        'Resolve it deliberately before deploying.',
    };
  }

  if (text.includes('drift') || text.includes('schema drift')) {
    return {
      severity: 'BLOCKER',
      check: 'migration status',
      detail:
        'Prisma reports DRIFT between the migration history and the database ' +
        'named by RELEASE_GATE_DATABASE_URL — the database was changed by ' +
        'something other than this history. Reconcile it before deploying.',
    };
  }

  if (exitCode !== 0) {
    return {
      severity: 'BLOCKER',
      check: 'migration status',
      detail:
        `\`prisma migrate status\` exited ${exitCode} against ` +
        'RELEASE_GATE_DATABASE_URL. The database could not be read, so the ' +
        'release cannot be certified against it. (Connection details are not ' +
        'printed.)',
    };
  }

  return {
    severity: 'WARNING',
    check: 'migration status',
    detail:
      '`prisma migrate status` succeeded but its output was not recognised ' +
      'by this gate. Read it directly before deploying.',
  };
}

/** The finding used when no database was supplied. Never a PASS. */
export function skippedMigrationStatus(): GateFinding {
  return {
    severity: 'SKIPPED',
    check: 'migration status',
    detail:
      'No RELEASE_GATE_DATABASE_URL was supplied, so no database was ' +
      'contacted and NOTHING about the target database has been verified — ' +
      'not whether it exists, not whether the migrations are applied. The ' +
      'ambient DATABASE_URL is ignored on purpose: connecting to whatever a ' +
      'shell happens to export would produce a confident answer about the ' +
      'wrong database. Supply it explicitly to enable this check.',
  };
}

/** Reads the `provider` out of a `migration_lock.toml`. */
export function parseLockProvider(toml: string): string | null {
  return /^\s*provider\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null;
}

/** Reads the `provider` out of the `datasource` block of a Prisma schema. */
export function parseSchemaProvider(schema: string): string | null {
  const datasource = /datasource\s+\w+\s*\{([\s\S]*?)\}/.exec(schema)?.[1];
  if (datasource === undefined) {
    return null;
  }
  return /^\s*provider\s*=\s*"([^"]+)"/m.exec(datasource)?.[1] ?? null;
}
