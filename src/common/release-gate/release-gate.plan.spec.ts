import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import {
  FOCUSED_PRODUCTION_CONFIG_SPECS,
  HLS_OPERATIONAL_ENTRYPOINTS,
  HLS_REGRESSION_SPECS,
  RELEASE_GATE_STEPS,
} from './release-gate.plan';
import { GateFinding, summarise, worstSeverity } from './release-gate.types';

/**
 * THE PLAN, checked against the repository it describes.
 *
 * WHY THIS SUITE IS NOT REDUNDANT WITH RUNNING THE GATE. A `--testPathPatterns`
 * entry that matches NOTHING is the quietest possible failure: the other
 * patterns still match, jest still exits 0, and the gate reports a green
 * "focused tests passed" having silently stopped running whichever contract
 * that pattern was there to protect. Nothing anywhere would say so.
 *
 * Read-only: it lists directories and reads `package.json`. It executes no
 * spec and runs no command.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');

/** Every `*.spec.ts` under `src/`, as repo-relative POSIX paths. */
function allSpecPaths(): string[] {
  const found: string[] = [];

  const walk = (absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(join(absolute, entry.name));
        continue;
      }
      if (!entry.name.endsWith('.spec.ts')) continue;
      found.push(
        relative(REPO_ROOT, join(absolute, entry.name)).split(sep).join('/'),
      );
    }
  };

  walk(join(REPO_ROOT, 'src'));
  return found;
}

const SPEC_PATHS = allSpecPaths();

const matching = (pattern: string): string[] => {
  const regex = new RegExp(pattern);
  return SPEC_PATHS.filter((path) => regex.test(path));
};

describe('release gate plan — every declared pattern matches a real suite', () => {
  it.each(FOCUSED_PRODUCTION_CONFIG_SPECS)(
    'production-config pattern %s matches at least one spec',
    (pattern) => {
      expect(matching(pattern).length).toBeGreaterThan(0);
    },
  );

  it.each(HLS_REGRESSION_SPECS)(
    'HLS regression pattern %s matches at least one spec',
    (pattern) => {
      expect(matching(pattern).length).toBeGreaterThan(0);
    },
  );

  it('CRITICAL: the release gate’s own suites are in the focused set', () => {
    const covered = FOCUSED_PRODUCTION_CONFIG_SPECS.flatMap(matching);

    // If the gate stopped running its own tests, every check in this
    // directory could rot without a single red run.
    expect(covered).toEqual(
      expect.arrayContaining([
        'src/common/release-gate/v1-feature-contract.spec.ts',
        'src/common/release-gate/secret-leak-scan.spec.ts',
        'src/common/release-gate/migration-consistency.spec.ts',
        'src/common/release-gate/release-mode.spec.ts',
        'src/common/release-gate/release-gate.plan.spec.ts',
        'src/common/release-gate/release-gate.report.spec.ts',
      ]),
    );
  });

  it('CRITICAL: the HLS set covers each contract it claims to', () => {
    const covered = HLS_REGRESSION_SPECS.flatMap(matching).join('\n');

    // Named individually rather than counted: a count passes just as happily
    // when the wrong twelve suites are listed.
    expect(covered).toContain('master-playlist'); // master/variant contract
    expect(covered).toContain('rendition-ladder'); // no forced 1080p
    expect(covered).toContain('hls-playback-token'); // playback authorisation
    expect(covered).toContain('hls-token-contract');
    expect(covered).toContain('hls-package-validator');
    expect(covered).toContain('playback-source'); // R2 precedence
    expect(covered).toContain('storage.service'); // safe URL generation
  });

  it('declares no pattern twice', () => {
    for (const patterns of [
      FOCUSED_PRODUCTION_CONFIG_SPECS,
      HLS_REGRESSION_SPECS,
    ]) {
      expect(new Set(patterns).size).toBe(patterns.length);
    }
  });
});

describe('release gate plan — operational entrypoints', () => {
  const pkg = JSON.parse(
    readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as { scripts?: Record<string, string> };

  it.each(HLS_OPERATIONAL_ENTRYPOINTS.map((e) => [e.script, e.file] as const))(
    'npm run %s still resolves to %s',
    (script, file) => {
      expect(pkg.scripts?.[script]).toBeDefined();
      expect(pkg.scripts![script]).toContain(file);
      expect(existsSync(join(REPO_ROOT, file))).toBe(true);
    },
  );

  it('every entrypoint states why losing it would matter', () => {
    for (const entry of HLS_OPERATIONAL_ENTRYPOINTS) {
      expect(entry.why.length).toBeGreaterThan(20);
    }
  });

  it('CRITICAL: package.json declares the release:gate script itself', () => {
    expect(pkg.scripts?.['release:gate']).toContain('scripts/release-gate.ts');
  });
});

describe('release gate plan — the step catalog', () => {
  it('has a unique, documented entry per step', () => {
    const ids = RELEASE_GATE_STEPS.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const step of RELEASE_GATE_STEPS) {
      expect(step.title.length).toBeGreaterThan(3);
      expect(step.what.length).toBeGreaterThan(20);
    }
  });

  it('CRITICAL: only the database-dependent steps may report SKIPPED', () => {
    // Any other optional step would be a way for the gate to get greener the
    // less it verifies.
    expect(
      RELEASE_GATE_STEPS.filter((step) => !step.alwaysRuns).map((s) => s.id),
    ).toEqual(['test:full', 'prisma:status']);
  });
});

describe('release gate reporting arithmetic', () => {
  const finding = (severity: GateFinding['severity']): GateFinding => ({
    severity,
    check: severity.toLowerCase(),
    detail: 'x',
  });

  it('ranks severities worst-first', () => {
    expect(worstSeverity([finding('PASS'), finding('BLOCKER')])).toBe(
      'BLOCKER',
    );
    expect(worstSeverity([finding('PASS'), finding('WARNING')])).toBe(
      'WARNING',
    );
    expect(worstSeverity([finding('PASS'), finding('SKIPPED')])).toBe(
      'SKIPPED',
    );
    expect(worstSeverity([])).toBe('PASS');
  });

  it('CRITICAL: a SKIPPED check never counts as a pass, and never clears ok', () => {
    const report = summarise([
      {
        id: 'a',
        title: 'a',
        durationMs: 0,
        findings: [finding('PASS'), finding('SKIPPED'), finding('WARNING')],
      },
    ]);

    expect(report.passes).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.warnings).toBe(1);
    // `ok` answers exactly one question — did anything BLOCK — and the caller
    // is responsible for reading `skipped` alongside it.
    expect(report.ok).toBe(true);
  });

  it('a single blocker anywhere clears ok', () => {
    const report = summarise([
      { id: 'a', title: 'a', durationMs: 0, findings: [finding('PASS')] },
      { id: 'b', title: 'b', durationMs: 0, findings: [finding('BLOCKER')] },
    ]);

    expect(report.blockers).toBe(1);
    expect(report.ok).toBe(false);
  });
});
