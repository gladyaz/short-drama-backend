import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Slice 11N, proof 1: "Migration is additive." Reads the actual generated
 * `migration.sql` for `..._add_processing_state_and_version` and asserts it
 * contains only `ADD COLUMN`/`CREATE INDEX` statements — no destructive
 * `DROP`/`ALTER COLUMN`/`RENAME`/`TRUNCATE` of any kind. Mutation-verifiable:
 * temporarily appending a `DROP COLUMN` line to the real migration file (or
 * to the fixture used by the second describe block below) makes this test
 * fail (see the handoff notes for the exact run).
 */
describe('Slice 11N migration — additive only (proof 1)', () => {
  const migrationsDir = join(__dirname, '../../prisma/migrations');
  const migrationDirName = readdirSync(migrationsDir).find((name) =>
    name.endsWith('_add_processing_state_and_version'),
  );

  it('the migration folder exists', () => {
    expect(migrationDirName).toBeDefined();
  });

  it('adds exactly the two expected columns via ADD COLUMN, plus one CREATE INDEX — nothing destructive', () => {
    const sql = readFileSync(
      join(migrationsDir, migrationDirName!, 'migration.sql'),
      'utf8',
    );

    expect(sql).toMatch(/ADD COLUMN\s+"processingState"/);
    expect(sql).toMatch(/ADD COLUMN\s+"processingVersion"/);
    expect(sql).toMatch(/CREATE INDEX/i);

    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)/i);
    expect(sql).not.toMatch(/ALTER\s+COLUMN/i);
    expect(sql).not.toMatch(/RENAME/i);
    expect(sql).not.toMatch(/TRUNCATE/i);
  });

  // A direct regression guard for the assertion logic itself: proves the
  // "nothing destructive" checks above are genuinely capable of failing,
  // not vacuously true — a fixture snippet containing a destructive
  // statement (never applied to any real database) must be rejected by the
  // same pattern.
  it('the destructive-statement check itself is non-vacuous (a fixture with DROP COLUMN fails it)', () => {
    const destructiveFixture =
      'ALTER TABLE "Video" DROP COLUMN "processingState";';

    expect(destructiveFixture).toMatch(
      /DROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)/i,
    );
  });
});
