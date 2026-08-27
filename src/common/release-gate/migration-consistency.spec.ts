import {
  checkMigrationHistory,
  interpretMigrateStatus,
  MigrationDirectory,
  parseLockProvider,
  parseSchemaProvider,
  skippedMigrationStatus,
} from './migration-consistency';
import { GateFinding } from './release-gate.types';

/**
 * MIGRATION SAFETY.
 *
 * Every input is an in-memory literal. Nothing here reads `prisma/`, opens a
 * connection, or runs a Prisma command.
 */

const migration = (
  name: string,
  overrides: Partial<MigrationDirectory> = {},
): MigrationDirectory => ({
  name,
  hasMigrationSql: true,
  sqlByteLength: 512,
  ...overrides,
});

const HEALTHY = {
  directories: [
    migration('20260723055428_init_postgresql'),
    migration('20260820134420_add_auth_identity_and_phone_otp'),
    migration('20260826140000_add_v1_reward_missions_and_perks'),
  ],
  lockProvider: 'postgresql',
  schemaProvider: 'postgresql',
};

const severities = (findings: GateFinding[]) =>
  findings.map((finding) => finding.severity);

describe('migration history — the healthy case', () => {
  it('passes a well-formed history', () => {
    const findings = checkMigrationHistory(HEALTHY);

    expect(severities(findings)).not.toContain('BLOCKER');
    expect(severities(findings)).not.toContain('WARNING');
    expect(
      findings.find((f) => f.check === 'migration history')?.detail,
    ).toContain('3 migration(s)');
  });
});

describe('migration history — what it refuses', () => {
  it('BLOCKS an empty migrations folder', () => {
    const findings = checkMigrationHistory({ ...HEALTHY, directories: [] });

    expect(findings[0].severity).toBe('BLOCKER');
    expect(findings[0].detail).toContain('no migration');
  });

  it('CRITICAL: BLOCKS a migration directory with no migration.sql', () => {
    // The silent one: `migrate deploy` records it as applied and moves on, so
    // the database is permanently behind the datamodel with nothing anywhere
    // reporting it.
    const findings = checkMigrationHistory({
      ...HEALTHY,
      directories: [
        ...HEALTHY.directories,
        migration('20260827090000_forgot_the_sql', {
          hasMigrationSql: false,
          sqlByteLength: 0,
        }),
      ],
    });

    const blocker = findings.find((f) => f.severity === 'BLOCKER')!;
    expect(blocker.check).toBe('migration file missing');
    expect(blocker.detail).toContain(
      'recorded as applied while changing nothing',
    );
  });

  it('BLOCKS an empty migration.sql', () => {
    const findings = checkMigrationHistory({
      ...HEALTHY,
      directories: [migration('20260723055428_init', { sqlByteLength: 0 })],
    });

    expect(findings.find((f) => f.severity === 'BLOCKER')?.check).toBe(
      'migration file empty',
    );
  });

  it('CRITICAL: BLOCKS out-of-order timestamps', () => {
    // A migration authored on a laptop whose clock or branch order differed
    // applies in a different relative order on a FRESH database — which is
    // what staging always is, and what an already-migrated dev database will
    // never reveal.
    const findings = checkMigrationHistory({
      ...HEALTHY,
      directories: [
        migration('20260826140000_second_authored_first_applied'),
        migration('20260820134420_first_authored_second_applied'),
      ],
    });

    const blocker = findings.find((f) => f.check === 'migration ordering')!;
    expect(blocker.severity).toBe('BLOCKER');
    expect(blocker.detail).toContain('fresh database');
  });

  it('warns on a name that is not <timestamp>_<name>', () => {
    const findings = checkMigrationHistory({
      ...HEALTHY,
      directories: [migration('manual-hotfix')],
    });

    expect(
      findings.find((f) => f.check === 'migration name shape')?.severity,
    ).toBe('WARNING');
  });

  it('BLOCKS a provider mismatch between the lock and the schema', () => {
    const findings = checkMigrationHistory({
      ...HEALTHY,
      schemaProvider: 'mysql',
    });

    const blocker = findings.find((f) => f.check === 'migration lock')!;
    expect(blocker.severity).toBe('BLOCKER');
    expect(blocker.detail).toContain('different engine');
  });

  it('BLOCKS a missing migration_lock.toml', () => {
    const findings = checkMigrationHistory({ ...HEALTHY, lockProvider: null });

    expect(findings.find((f) => f.check === 'migration lock')?.severity).toBe(
      'BLOCKER',
    );
  });
});

describe('migration status — interpreting a read-only `prisma migrate status`', () => {
  it('passes an up-to-date database', () => {
    const finding = interpretMigrateStatus(0, 'Database schema is up to date!');

    expect(finding.severity).toBe('PASS');
    expect(finding.detail).toContain('Nothing was applied');
  });

  it('WARNS — never blocks — on pending migrations', () => {
    // `start:migrate:prod` runs `migrate deploy` first, so pending
    // migrations are the NORMAL state immediately before a release that
    // ships a schema change. Blocking would refuse every such release.
    const finding = interpretMigrateStatus(
      1,
      'Following migration have not yet been applied:\n20260826140000_add_v1_reward_missions_and_perks',
    );

    expect(finding.severity).toBe('WARNING');
    expect(finding.detail).toContain('V1_STAGING_RUNBOOK');
    expect(finding.detail).toContain('Nothing was applied');
  });

  it('BLOCKS a recorded failed migration', () => {
    const finding = interpretMigrateStatus(
      1,
      'The following migrations have failed:\n20260820134420_add_auth_identity',
    );

    expect(finding.severity).toBe('BLOCKER');
    expect(finding.detail).toContain(
      'would start, fail to migrate, and not boot',
    );
  });

  it('BLOCKS reported drift', () => {
    expect(
      interpretMigrateStatus(
        1,
        'Drift detected: your database schema is not in sync',
      ).severity,
    ).toBe('BLOCKER');
  });

  it('BLOCKS an unreadable database without printing connection details', () => {
    const finding = interpretMigrateStatus(
      1,
      "P1001: Can't reach database server at `db.internal:5432`",
    );

    expect(finding.severity).toBe('BLOCKER');
    expect(finding.detail).not.toContain('db.internal');
  });

  it('CRITICAL: never claims a pass for a database it did not contact', () => {
    const skipped = skippedMigrationStatus();

    expect(skipped.severity).toBe('SKIPPED');
    expect(skipped.detail).toContain('NOTHING about the target database');
    expect(skipped.detail).toContain('ambient DATABASE_URL is ignored');
  });
});

describe('migration parsers', () => {
  it('reads the provider out of a migration_lock.toml', () => {
    expect(
      parseLockProvider(
        '# Please do not edit this file manually\nprovider = "postgresql"\n',
      ),
    ).toBe('postgresql');
    expect(parseLockProvider('')).toBeNull();
  });

  it('reads the provider out of the datasource block only', () => {
    const schema = [
      'generator client {',
      '  provider = "prisma-client-js"',
      '}',
      '',
      'datasource db {',
      '  provider = "postgresql"',
      '  url      = env("DATABASE_URL")',
      '}',
    ].join('\n');

    // The generator block also has a `provider`; reading the first one in the
    // file would compare the migration lock against "prisma-client-js".
    expect(parseSchemaProvider(schema)).toBe('postgresql');
    expect(parseSchemaProvider('model User {}')).toBeNull();
  });
});
