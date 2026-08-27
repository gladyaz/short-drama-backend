/**
 * HOW A RELEASE-GATE REPORT IS RENDERED.
 *
 * Split out of `scripts/release-gate.ts` so the presentation is UNIT
 * TESTABLE, and for the same reason `production-preflight/preflight.ts` keeps
 * its rules out of the script that prints them: what a report SAYS is
 * load-bearing, and a thing only reachable by running twelve subprocesses
 * cannot be asserted on.
 *
 * TWO PROPERTIES THESE FUNCTIONS EXIST TO GUARANTEE:
 *
 *   1. A SKIPPED CHECK IS NEVER INVISIBLE. It prints in its own line with the
 *      reason, is counted separately from passes, and is repeated in the
 *      verdict block. A gate that got greener the less it could verify would
 *      be worse than no gate.
 *
 *   2. THE VERDICT NEVER OVERSTATES ITSELF. Every run prints what the mode
 *      does and does not prove, and the ENGINEERING READY / EXTERNAL CONFIG
 *      READY / DEPLOYED-VERIFIED ladder, because "0 blockers" is the phrase
 *      that gets quoted and the rest is the part that gets forgotten.
 *
 * Nothing here formats a value that is not public by nature. Secrets never
 * reach a finding in the first place (see `secret-leak-scan.ts`), and this
 * layer adds none.
 */
import { RELEASE_GATE_STEPS } from './release-gate.plan';
import { GateReport, GateSeverity, GateStepResult } from './release-gate.types';
import { ReleaseModeResolution } from './release-mode';

/** Emits one line. Injected so the spec can capture output without spying on console. */
export type Emit = (line: string) => void;

export const ICON: Record<GateSeverity, string> = {
  PASS: '✓',
  WARNING: '!',
  BLOCKER: '✗',
  SKIPPED: '–',
};

export function printHeader(
  resolution: ReleaseModeResolution,
  emit: Emit,
): void {
  emit('');
  emit('RED PANDA V1 — FINAL RELEASE GATE');
  emit(`  mode           ${resolution.mode}`);
  emit(`  configuration  ${resolution.configSource}`);
  emit(`  feature policy ${resolution.policyEnforcement}`);
  emit(
    '  read-only      no deploy, no migration, no queue, no bucket, no message',
  );
}

export function printStep(step: GateStepResult, emit: Emit): void {
  const shown = step.findings.filter((finding) => finding.severity !== 'PASS');
  const passes = step.findings.length - shown.length;

  emit('');
  emit(`── ${step.title}  (${step.durationMs}ms)`);

  for (const finding of shown) {
    emit(`   ${ICON[finding.severity]} ${finding.severity}  ${finding.check}`);
    for (const line of finding.detail.split('\n')) {
      emit(`      ${line}`);
    }
  }

  if (passes > 0) {
    emit(`   ${ICON.PASS} ${passes} check(s) passed.`);
  }
}

export function printVerdict(
  report: GateReport,
  resolution: ReleaseModeResolution,
  emit: Emit,
): void {
  emit('');
  emit('─'.repeat(72));
  emit(
    `  ${report.blockers} BLOCKER(s)   ${report.warnings} WARNING(s)   ` +
      `${report.skipped} SKIPPED   ${report.passes} PASS`,
  );
  emit('');

  if (report.blockers > 0) {
    emit('  VERDICT: BLOCKED — this release must not be deployed.');
    emit('  Fix every BLOCKER above and run the gate again.');
  } else {
    emit('  VERDICT: NO BLOCKERS.');
  }

  emit('');
  emit(`  ${resolution.claim}`);

  if (report.skipped > 0) {
    emit('');
    emit(
      `  ${report.skipped} check(s) DID NOT RUN and are not part of this verdict. ` +
        'Read the SKIPPED lines above before treating this as complete.',
    );
  }

  emit('');
  emit(
    '  ENGINEERING READY is not EXTERNAL CONFIG READY and neither is DEPLOYED/VERIFIED.',
  );
  emit('  See docs/V1_RELEASE_GATE.md for what each level means.');
  emit('  Nothing was deployed, connected to, or modified by this command.');
  emit('');
}

export function printPlan(emit: Emit): void {
  emit('');
  emit('RELEASE GATE CHECKS');
  for (const step of RELEASE_GATE_STEPS) {
    emit(`  ${step.alwaysRuns ? ' ' : '~'} ${step.id.padEnd(18)} ${step.what}`);
  }
  emit('');
  emit('  ~ = may report SKIPPED (needs a database you supply explicitly)');
  emit('');
}
