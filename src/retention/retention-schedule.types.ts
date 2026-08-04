/**
 * Phase 13, work unit 13A-B2 (closes the "scheduling is Phase 13's" earmark,
 * `TASK_QUEUE.md` follow-up item 15; approved `DECISIONS.md` 2026-08-04): the
 * three `RETENTION_SCHEDULE_*` env vars that control
 * `RetentionSchedulerService`, resolved once per process boot by
 * `resolveRetentionScheduleConfig` (`retention-schedule.config.ts`). Kept as
 * its own small types file, mirroring the `ads-config.types.ts` /
 * `ads-config.service.ts` split precedent already in this codebase, purely
 * for file cohesion — nothing here has any behavior of its own.
 */
export interface RetentionScheduleConfig {
  /**
   * `RETENTION_SCHEDULE_ENABLED`: must be EXACTLY the string `'true'` to
   * enable the scheduled job — fail-closed by construction. Unset, `''`,
   * `'1'`, `'TRUE'`, `'yes'`, or any other value all resolve to `false`
   * (disabled, the default) — see `resolveRetentionScheduleConfig`'s own doc
   * comment for why this is a strict `=== 'true'` equality check, never a
   * truthy/loose check. When `false`, `RetentionSchedulerService` registers
   * NO cron job at all (not a "registered but disabled" job).
   */
  enabled: boolean;
  /**
   * `RETENTION_SCHEDULE_CRON`: a cron expression consumed directly by
   * `cron`'s `CronJob` constructor (via `RetentionSchedulerService`), which
   * validates it synchronously and throws for a malformed value — see that
   * service's doc comment for why an invalid expression is deliberately left
   * to fail loudly at boot, not caught or silently defaulted here.
   */
  cronExpression: string;
  /**
   * `RETENTION_SCHEDULE_COMMIT`: must be EXACTLY the string `'true'` to run
   * the scheduled job in destructive (commit) mode. Any other value
   * (including unset, the default) is a DRY RUN — mirrors `enabled`'s
   * fail-closed shape exactly. A `true` value here does NOT bypass
   * `RetentionService.run`'s own `assertDestructiveRetentionAllowed()` call —
   * see `RetentionSchedulerService`'s doc comment.
   */
  commit: boolean;
}

/**
 * Daily at 03:00 local server time — the default used whenever
 * `RETENTION_SCHEDULE_CRON` is unset or blank.
 */
export const DEFAULT_RETENTION_SCHEDULE_CRON = '0 3 * * *';
