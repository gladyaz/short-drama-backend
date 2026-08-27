/**
 * RED PANDA V1 FINAL RELEASE GATE — the vocabulary every check in this
 * directory reports in.
 *
 * WHY A SEPARATE SEVERITY FROM THE PREFLIGHT'S. `production-preflight` grades
 * one thing — a candidate environment record — and its three severities are
 * enough for that. The release gate grades a RELEASE, which is a wider claim
 * made of steps that can also legitimately NOT RUN: a migration status check
 * has nothing to say without a database, and a database-backed test suite
 * must not be run against a shared one just to make a report look complete.
 *
 * So this type adds `SKIPPED`, and the whole reporting design turns on it:
 *
 *   A SKIPPED STEP IS NEVER COUNTED AS A PASS, is printed in its own section
 *   with the reason it did not run, and is repeated in the final verdict
 *   line. A gate that quietly omitted the checks it could not perform would
 *   be a gate that gets greener the less it is able to verify, which is the
 *   exact failure mode this file exists to make impossible.
 */

/** Public URL/flag values only — a detail string must never carry a secret. */
export type GateSeverity = 'PASS' | 'WARNING' | 'BLOCKER' | 'SKIPPED';

export interface GateFinding {
  severity: GateSeverity;
  /** Short, stable name of the check, for scanning a report. */
  check: string;
  /** Why, in one or two sentences. NEVER contains a secret value. */
  detail: string;
}

/**
 * One orchestrated step of the gate (a build, a test run, an inline
 * analysis). A step contributes zero or more findings; its own severity is
 * the worst of them.
 */
export interface GateStepResult {
  /** Stable machine id, e.g. `build`, `leak-scan`. Used by CI and by tests. */
  id: string;
  /** Human title printed as the section heading. */
  title: string;
  findings: GateFinding[];
  /** Wall-clock milliseconds the step took, for the timing summary. */
  durationMs: number;
}

export interface GateReport {
  steps: GateStepResult[];
  blockers: number;
  warnings: number;
  skipped: number;
  passes: number;
  /**
   * True when nothing BLOCKS the release. Warnings and skips do not clear
   * this flag, and — deliberately — do not set it either: `ok` answers
   * exactly one question, "did any check refuse this release", and the
   * caller is responsible for reading `skipped` alongside it.
   */
  ok: boolean;
}

export type EnvRecord = Record<string, string | undefined>;

export const SEVERITY_ORDER: readonly GateSeverity[] = [
  'BLOCKER',
  'WARNING',
  'SKIPPED',
  'PASS',
];

/** The worst severity present, or `PASS` when there are no findings at all. */
export function worstSeverity(findings: readonly GateFinding[]): GateSeverity {
  for (const severity of SEVERITY_ORDER) {
    if (findings.some((finding) => finding.severity === severity)) {
      return severity;
    }
  }
  return 'PASS';
}

export function summarise(steps: readonly GateStepResult[]): GateReport {
  const findings = steps.flatMap((step) => step.findings);
  const count = (severity: GateSeverity): number =>
    findings.filter((finding) => finding.severity === severity).length;

  const blockers = count('BLOCKER');

  return {
    steps: [...steps],
    blockers,
    warnings: count('WARNING'),
    skipped: count('SKIPPED'),
    passes: count('PASS'),
    ok: blockers === 0,
  };
}
