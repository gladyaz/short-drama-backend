import {
  printHeader,
  printPlan,
  printStep,
  printVerdict,
} from './release-gate.report';
import { GateFinding, GateStepResult, summarise } from './release-gate.types';
import { resolveReleaseGateMode } from './release-mode';

/**
 * WHAT A RELEASE-GATE REPORT SAYS.
 *
 * The two properties asserted here are the ones a reader's trust rests on: a
 * skipped check is never invisible, and a clean verdict never overstates
 * itself. Both are pure string output, so they are cheap to pin — and both
 * would otherwise only be reachable by running twelve subprocesses.
 */

const capture = (render: (emit: (line: string) => void) => void): string => {
  const lines: string[] = [];
  render((line) => lines.push(line));
  return lines.join('\n');
};

const finding = (
  severity: GateFinding['severity'],
  check = 'a-check',
  detail = 'a detail',
): GateFinding => ({ severity, check, detail });

const step = (findings: GateFinding[]): GateStepResult => ({
  id: 'demo',
  title: 'Demo step',
  durationMs: 12,
  findings,
});

describe('report — the header states what is being graded', () => {
  it.each(['local', 'ci', 'production'] as const)(
    'names the mode, the config source and the enforcement for %s',
    (mode) => {
      const resolution = resolveReleaseGateMode(mode, {});
      const output = capture((emit) => printHeader(resolution, emit));

      expect(output).toContain(mode);
      expect(output).toContain(resolution.configSource);
      expect(output).toContain(resolution.policyEnforcement);
      // The read-only promise is on every run, not only clean ones.
      expect(output).toContain('read-only');
    },
  );
});

describe('report — a SKIPPED check is never invisible', () => {
  const output = capture((emit) =>
    printStep(
      step([
        finding('PASS', 'ran'),
        finding('SKIPPED', 'migration status', 'No database was supplied.'),
      ]),
      emit,
    ),
  );

  it('CRITICAL: prints the skipped check and its reason in full', () => {
    expect(output).toContain('SKIPPED');
    expect(output).toContain('migration status');
    expect(output).toContain('No database was supplied.');
  });

  it('CRITICAL: does not fold it into the passed count', () => {
    // "2 check(s) passed" beside a check that did not run is the exact lie
    // this gate exists not to tell.
    expect(output).toContain('1 check(s) passed');
    expect(output).not.toContain('2 check(s) passed');
  });

  it('collapses passes but never a warning or a blocker', () => {
    const noisy = capture((emit) =>
      printStep(
        step([
          finding('PASS'),
          finding('PASS'),
          finding('WARNING', 'a-warning', 'worth reading'),
          finding('BLOCKER', 'a-blocker', 'stop'),
        ]),
        emit,
      ),
    );

    expect(noisy).toContain('2 check(s) passed');
    expect(noisy).toContain('a-warning');
    expect(noisy).toContain('a-blocker');
  });
});

describe('report — the verdict never overstates itself', () => {
  const verdictFor = (findings: GateFinding[], mode: 'ci' | 'local' = 'ci') =>
    capture((emit) =>
      printVerdict(
        summarise([step(findings)]),
        resolveReleaseGateMode(mode, {}),
        emit,
      ),
    );

  it('refuses a release when anything blocks', () => {
    const output = verdictFor([finding('BLOCKER')]);

    expect(output).toContain('BLOCKED');
    expect(output).toContain('must not be deployed');
  });

  it('CRITICAL: a clean run still prints the three-level ladder', () => {
    const output = verdictFor([finding('PASS')]);

    expect(output).toContain('NO BLOCKERS');
    // "0 blockers" is the phrase that gets quoted; this is the part that
    // otherwise gets forgotten.
    expect(output).toContain('ENGINEERING READY');
    expect(output).toContain('EXTERNAL CONFIG READY');
    expect(output).toContain('DEPLOYED/VERIFIED');
    expect(output).toContain('Nothing was deployed');
  });

  it('CRITICAL: repeats the skipped count beside a clean verdict', () => {
    const output = verdictFor([finding('PASS'), finding('SKIPPED')]);

    expect(output).toContain('NO BLOCKERS');
    expect(output).toContain('1 check(s) DID NOT RUN');
    expect(output).toContain('not part of this verdict');
  });

  it('says nothing about skips when there are none', () => {
    expect(verdictFor([finding('PASS')])).not.toContain('DID NOT RUN');
  });

  it('carries the mode’s claim verbatim, so CI is never read as verified', () => {
    expect(verdictFor([finding('PASS')], 'ci')).toContain('CODE-VALID');
    expect(verdictFor([finding('PASS')], 'local')).toContain('ADVISORY');
  });

  it('prints every severity count, not only the blockers', () => {
    const output = verdictFor([
      finding('BLOCKER'),
      finding('WARNING'),
      finding('SKIPPED'),
      finding('PASS'),
    ]);

    expect(output).toMatch(/1 BLOCKER\(s\)/);
    expect(output).toMatch(/1 WARNING\(s\)/);
    expect(output).toMatch(/1 SKIPPED/);
    expect(output).toMatch(/1 PASS/);
  });
});

describe('report — --list', () => {
  const output = capture((emit) => printPlan(emit));

  it('lists every step with what it does', () => {
    expect(output).toContain('build');
    expect(output).toContain('leak-scan');
    expect(output).toContain('prisma:status');
  });

  it('marks the steps that may not run', () => {
    expect(output).toContain('~ = may report SKIPPED');
  });
});
