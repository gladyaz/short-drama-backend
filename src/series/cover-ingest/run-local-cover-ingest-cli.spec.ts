import { resolve } from 'path';
import {
  DEFAULT_COVER_ASSET_DIR,
  formatCoverIngestReport,
  parseCoverIngestArgs,
} from './run-local-cover-ingest-cli';
import { LocalCoverIngestReport } from './local-cover-ingest.types';

/**
 * Work unit "LOCAL SERIES COVER ARTWORK": the CLI's two safety properties —
 * writing is opt-in, and an ambiguous `--source` is refused rather than
 * silently resolved.
 */
describe('parseCoverIngestArgs', () => {
  const argv = (...args: string[]): string[] => ['node', 'script', ...args];

  it('defaults to a DRY RUN against the committed assets', () => {
    // Writing must be opt-in. A default that applied would make an
    // exploratory run edit the catalog.
    expect(parseCoverIngestArgs(argv())).toEqual({
      sourceDir: resolve(DEFAULT_COVER_ASSET_DIR),
      apply: false,
    });
  });

  it('applies only when --apply is passed', () => {
    expect(parseCoverIngestArgs(argv('--apply')).apply).toBe(true);
  });

  it('resolves a relative --source to an absolute path', () => {
    expect(parseCoverIngestArgs(argv('--source=some/posters')).sourceDir).toBe(
      resolve('some/posters'),
    );
  });

  /**
   * `--source=` is what a mistyped or unset shell variable expands to.
   * Falling back to the committed assets there would ingest artwork the
   * operator did not ask for, under the impression it came from their own
   * directory.
   */
  it('refuses an empty --source rather than falling back to the default', () => {
    expect(() => parseCoverIngestArgs(argv('--source='))).toThrow(
      '--source= requires a directory path.',
    );
  });

  it('refuses an unknown argument rather than ignoring it', () => {
    expect(() => parseCoverIngestArgs(argv('--aply'))).toThrow(
      /Unknown argument: --aply/,
    );
  });
});

describe('formatCoverIngestReport', () => {
  function buildReport(
    overrides: Partial<LocalCoverIngestReport> = {},
  ): LocalCoverIngestReport {
    return {
      driver: 'local',
      sourceDir: '/repo/assets/series-covers',
      localRoot: '/repo/storage/local-objects',
      applied: false,
      outcomes: [],
      ...overrides,
    };
  }

  it('says plainly that a dry run wrote nothing', () => {
    expect(formatCoverIngestReport(buildReport())).toContain(
      'MODE: DRY RUN (nothing written)',
    );
  });

  it('says plainly that an apply wrote', () => {
    expect(formatCoverIngestReport(buildReport({ applied: true }))).toContain(
      'MODE: APPLY (files copied, rows updated)',
    );
  });

  it('prompts for --apply only when there is something to write', () => {
    const withWork = formatCoverIngestReport(
      buildReport({
        outcomes: [
          {
            seriesId: 'series-104',
            title: 'Fixture',
            status: 'would-ingest',
            sourcePath: '/repo/assets/series-covers/series-104.webp',
            key: 'admin-series/series-104/cover/uuid',
            contentType: 'image/webp',
            bytes: 59960,
            previousCoverImageKey: null,
          },
        ],
      }),
    );

    expect(withWork).toContain('Re-run with --apply');
    expect(formatCoverIngestReport(buildReport())).not.toContain(
      'Re-run with --apply',
    );
  });

  it('surfaces a failure reason instead of burying it in a count', () => {
    const output = formatCoverIngestReport(
      buildReport({
        outcomes: [
          {
            seriesId: 'series-104',
            title: 'Fixture',
            status: 'failed',
            sourcePath: '/repo/assets/series-covers/series-104.webp',
            reason: 'Leading bytes are not a permitted cover format',
          },
        ],
      }),
    );

    expect(output).toContain('FAILED');
    expect(output).toContain('not a permitted cover format');
    expect(output).toContain('failed=1');
  });
});
