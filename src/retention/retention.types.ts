/**
 * Phase 12, work unit 12D-B1: shapes for `RetentionService`'s report/run
 * output. Kept as a small, self-contained "report" shape (mirroring the
 * existing `DryRunReport` convention in `src/importer/dryrun.types.ts` —
 * this codebase already has a precedent for "describe what WOULD happen"
 * result types), not a Prisma-derived type, so the CLI script
 * (`scripts/run-retention.ts`) and the test suites can depend on a stable
 * contract independent of the underlying queries.
 */

export type RetentionTargetName =
  | 'session'
  | 'passwordResetToken'
  | 'authAuditEvent'
  | 'analyticsEvent'
  | 'watchProgress'
  | 'deletedAccountResidue';

/**
 * Per-Prisma-model breakdown for the `deletedAccountResidue` target only —
 * see `RetentionService.processDeletedAccountResidue`'s doc comment for why
 * this target has no time-based cutoff and is expected, by construction, to
 * always report zero matches under normal operation.
 */
export interface RetentionResidueModelDetail {
  model: string;
  matchedCount: number;
  /** Always 0 when the overall run was a dry run (`commit: false`). */
  deletedCount: number;
}

export interface RetentionTargetReport {
  target: RetentionTargetName;
  /**
   * The UTC cutoff instant used for this target's `< cutoff` comparison, or
   * `null` for `deletedAccountResidue` (which has no time window at all —
   * see that target's own doc comment).
   */
  cutoff: Date | null;
  /** Rows that meet this target's deletion criteria, whether or not they were actually deleted. */
  matchedCount: number;
  /** Always 0 when the overall run was a dry run (`commit: false`) — see `RetentionService.run`. */
  deletedCount: number;
  /** Present only for the `deletedAccountResidue` target. */
  residueDetails?: RetentionResidueModelDetail[];
}

export interface RetentionReport {
  generatedAt: Date;
  /** Whether this run actually deleted rows (`true`) or only counted them (`false`, the default). */
  commit: boolean;
  targets: RetentionTargetReport[];
}

export interface RunRetentionOptions {
  /**
   * Must be the literal boolean `true` to delete anything — mirrors the
   * `AccountDeletionDto.confirmDeletion` "must be a literal `true`, not a
   * truthy string" precedent from 12C-B1. Any other value (including
   * omission) is treated as a dry run. Defaults to `false`.
   */
  commit?: boolean;
  /**
   * Injectable clock, defaulting to `new Date()`. Exists so tests can pass a
   * fixed instant for deterministic retention-window boundary assertions
   * (see `retention.integration.spec.ts`) rather than racing the real clock.
   */
  now?: Date;
}
