import { INestApplicationContext } from '@nestjs/common';
import {
  RunSeriesCoverOrphansCliDeps,
  runSeriesCoverOrphansCli,
} from './run-series-cover-orphans-cli';
import { SeriesCoverOrphanService } from './series-cover-orphan.service';
import {
  RunSeriesCoverOrphanCleanupOptions,
  SeriesCoverOrphanReport,
} from './series-cover-orphan.types';

/**
 * Slice "SERIES COVER ORPHAN CLEANUP LIFECYCLE": the CLI's own regression
 * tests. No Nest context is ever booted here and no `PrismaService`/
 * `S3Client` is ever constructed — `createContext` is always a stub, which
 * is precisely what lets the "the gate refuses BEFORE anything is
 * constructed" claim be asserted by construction rather than by inspection.
 */
describe('runSeriesCoverOrphansCli', () => {
  function buildReport(
    overrides: Partial<SeriesCoverOrphanReport> = {},
  ): SeriesCoverOrphanReport {
    return {
      generatedAt: new Date('2026-08-18T00:00:00.000Z'),
      apply: false,
      graceMs: 24 * 60 * 60 * 1000,
      cutoff: new Date('2026-08-17T00:00:00.000Z'),
      pagesScanned: 1,
      listTruncated: false,
      scanned: 0,
      ignoredForeignKey: 0,
      protected: 0,
      unknownAge: 0,
      tooRecent: 0,
      seriesRecentlyModified: 0,
      eligible: 0,
      deleted: 0,
      failed: 0,
      skippedOnRecheck: 0,
      candidates: [],
      candidatesTruncated: false,
      ...overrides,
    };
  }

  function buildDeps(
    report: SeriesCoverOrphanReport = buildReport(),
  ): RunSeriesCoverOrphansCliDeps & {
    run: jest.Mock<Promise<SeriesCoverOrphanReport>, [unknown]>;
    close: jest.Mock;
    lines: string[];
  } {
    const lines: string[] = [];
    const run = jest.fn((options: RunSeriesCoverOrphanCleanupOptions) =>
      Promise.resolve({ ...report, apply: options.apply === true }),
    ) as jest.Mock<Promise<SeriesCoverOrphanReport>, [unknown]>;
    const close = jest.fn().mockResolvedValue(undefined);

    const context = {
      get: (token: unknown) => {
        expect(token).toBe(SeriesCoverOrphanService);
        return { run } as unknown as SeriesCoverOrphanService;
      },
      close,
    } as unknown as INestApplicationContext;

    return {
      assertApplyAllowed: jest.fn(),
      createContext: jest.fn().mockResolvedValue(context),
      log: (message: string) => lines.push(message),
      run,
      close,
      lines,
    };
  }

  describe('dry run (no flags) is the default', () => {
    it('runs with apply:false and never invokes the destructive gate', async () => {
      const deps = buildDeps();

      await runSeriesCoverOrphansCli(['node', 'script'], deps);

      expect(deps.run).toHaveBeenCalledWith({ apply: false });
      expect(deps.assertApplyAllowed).not.toHaveBeenCalled();
    });

    it('prints a heading that says nothing was removed', async () => {
      const deps = buildDeps();

      await runSeriesCoverOrphansCli(['node', 'script'], deps);

      expect(deps.lines[0]).toContain('DRY RUN');
      expect(deps.lines[0]).toContain('nothing was removed');
      expect(deps.lines.join('\n')).toContain('This was a DRY RUN.');
    });

    it('never injects a clock, so production always sweeps against the real time', async () => {
      // `RunSeriesCoverOrphanCleanupOptions.now` moves the eligibility
      // cutoff, and a FUTURE value would make the sweep more aggressive.
      // This exact-equality assertion is what keeps that knob unreachable
      // from the operator surface: adding a `now` here fails this test.
      const deps = buildDeps();

      await runSeriesCoverOrphansCli(['node', 'script'], deps);

      expect(deps.run).toHaveBeenCalledWith({ apply: false });
      expect(deps.run.mock.calls[0][0]).not.toHaveProperty('now');
    });

    it('does not treat an unrelated flag as --apply', async () => {
      const deps = buildDeps();

      await runSeriesCoverOrphansCli(
        ['node', 'script', '--applied', '-a'],
        deps,
      );

      expect(deps.run).toHaveBeenCalledWith({ apply: false });
      expect(deps.assertApplyAllowed).not.toHaveBeenCalled();
    });
  });

  describe('--apply', () => {
    it('runs the gate BEFORE any context is created', async () => {
      const deps = buildDeps();
      const callOrder: string[] = [];
      (deps.assertApplyAllowed as jest.Mock).mockImplementation(() => {
        callOrder.push('gate');
      });
      (deps.createContext as jest.Mock).mockImplementation(() => {
        callOrder.push('context');
        return Promise.resolve({
          get: () => ({ run: deps.run }),
          close: deps.close,
        } as unknown as INestApplicationContext);
      });

      await runSeriesCoverOrphansCli(['node', 'script', '--apply'], deps);

      expect(callOrder).toEqual(['gate', 'context']);
      expect(deps.run).toHaveBeenCalledWith({ apply: true });
    });

    it('a refusing gate means ZERO context construction and ZERO service calls', async () => {
      const deps = buildDeps();
      (deps.assertApplyAllowed as jest.Mock).mockImplementation(() => {
        throw new Error('refused by the guard');
      });

      await expect(
        runSeriesCoverOrphansCli(['node', 'script', '--apply'], deps),
      ).rejects.toThrow('refused by the guard');

      // The whole point: no Nest context, therefore no PrismaService and no
      // S3Client were ever constructed, therefore no connection or storage
      // request could have been issued.
      expect(deps.createContext).not.toHaveBeenCalled();
      expect(deps.run).not.toHaveBeenCalled();
    });

    it('prints an apply heading and omits the dry-run footer', async () => {
      const deps = buildDeps();

      await runSeriesCoverOrphansCli(['node', 'script', '--apply'], deps);

      expect(deps.lines[0]).toContain('APPLY');
      expect(deps.lines.join('\n')).not.toContain('This was a DRY RUN.');
    });
  });

  describe('report rendering', () => {
    it('prints every summary counter', async () => {
      const deps = buildDeps(
        buildReport({
          scanned: 9,
          ignoredForeignKey: 1,
          protected: 2,
          unknownAge: 1,
          tooRecent: 1,
          seriesRecentlyModified: 1,
          eligible: 3,
          deleted: 0,
          failed: 0,
          skippedOnRecheck: 0,
        }),
      );

      await runSeriesCoverOrphansCli(['node', 'script'], deps);
      const output = deps.lines.join('\n');

      expect(output).toContain('scanned:                9');
      expect(output).toContain('ignoredForeignKey:    1');
      expect(output).toContain('protected:            2');
      expect(output).toContain('unknownAge:           1');
      expect(output).toContain('tooRecent:            1');
      expect(output).toContain('seriesRecentlyModified: 1');
      expect(output).toContain('eligible:             3');
      expect(output).toContain('deleted:                0');
      expect(output).toContain('failed:                 0');
      expect(output).toContain('skippedOnRecheck:       0');
    });

    it('prints each candidate key, series, age and reason', async () => {
      const deps = buildDeps(
        buildReport({
          eligible: 1,
          candidates: [
            {
              key: 'admin-series/series-104/cover/uuid-1',
              seriesId: 'series-104',
              lastModified: new Date('2026-08-15T00:00:00.000Z'),
              ageMs: 72 * 60 * 60 * 1000,
              reason: 'unreferenced-and-past-grace',
              outcome: 'dry-run',
            },
          ],
        }),
      );

      await runSeriesCoverOrphansCli(['node', 'script'], deps);
      const output = deps.lines.join('\n');

      expect(output).toContain('admin-series/series-104/cover/uuid-1');
      expect(output).toContain('series=series-104');
      expect(output).toContain('age=72h');
      expect(output).toContain('reason=unreferenced-and-past-grace');
      expect(output).toContain('outcome=dry-run');
    });

    it('never prints a signed URL, endpoint, bucket, or credential', async () => {
      const deps = buildDeps(
        buildReport({
          eligible: 1,
          candidates: [
            {
              key: 'admin-series/series-104/cover/uuid-1',
              seriesId: 'series-104',
              lastModified: new Date('2026-08-15T00:00:00.000Z'),
              ageMs: 1,
              reason: 'unreferenced-and-past-grace',
              outcome: 'dry-run',
            },
          ],
        }),
      );

      await runSeriesCoverOrphansCli(['node', 'script'], deps);
      const output = deps.lines.join('\n');

      expect(output).not.toMatch(
        /X-Amz-Signature|X-Amz-Credential|https?:\/\//,
      );
      expect(output).not.toContain('AccessKey');
    });

    it('loudly reports a truncated listing rather than implying full coverage', async () => {
      const deps = buildDeps(buildReport({ listTruncated: true }));

      await runSeriesCoverOrphansCli(['node', 'script'], deps);

      expect(deps.lines.join('\n')).toContain('WARNING');
      expect(deps.lines.join('\n')).toContain('did NOT examine the entire');
    });

    it('notes a truncated candidate list while stating the counters are still exact', async () => {
      const deps = buildDeps(buildReport({ candidatesTruncated: true }));

      await runSeriesCoverOrphansCli(['node', 'script'], deps);

      expect(deps.lines.join('\n')).toContain(
        'counters above are still exact and complete',
      );
    });
  });

  it('closes the context even when the sweep throws', async () => {
    const deps = buildDeps();
    deps.run.mockRejectedValue(new Error('sweep exploded'));

    await expect(
      runSeriesCoverOrphansCli(['node', 'script'], deps),
    ).rejects.toThrow('sweep exploded');

    expect(deps.close).toHaveBeenCalledTimes(1);
  });
});
