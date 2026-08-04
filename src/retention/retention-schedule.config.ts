import {
  DEFAULT_RETENTION_SCHEDULE_CRON,
  RetentionScheduleConfig,
} from './retention-schedule.types';

/**
 * Phase 13, work unit 13A-B2: resolves the three `RETENTION_SCHEDULE_*` env
 * vars into a `RetentionScheduleConfig`. Reads `process.env` directly (the
 * injectable `env` param defaults to it, purely for test isolation — this
 * mirrors `resolveStorageDriver` in `../config/configuration.ts` and
 * `AdsConfigService` in `../ads-config/ads-config.service.ts`, this
 * codebase's two existing precedents for env-var parsing that is optional,
 * per-field-defaulting, and never fails boot on its own — a materially
 * different validation shape from what the global
 * `configuration.ts`/`env.validation.ts` pair already does, which is why
 * this lives in its own file rather than being folded into either of them).
 *
 * `enabled` and `commit` are both **exact-string, fail-closed** checks
 * (`=== 'true'`), deliberately never `!== 'false'` or any other
 * default-to-permissive shape — this is a literal acceptance criterion for
 * this work unit: unset, `''`, `'1'`, `'TRUE'`, `'yes'`, or any value other
 * than the exact lowercase string `'true'` must resolve to `false` (no
 * scheduled job / dry run), never the reverse.
 */
export function resolveRetentionScheduleConfig(
  env: NodeJS.ProcessEnv = process.env,
): RetentionScheduleConfig {
  const rawCron = env.RETENTION_SCHEDULE_CRON?.trim();

  return {
    enabled: env.RETENTION_SCHEDULE_ENABLED === 'true',
    cronExpression:
      rawCron && rawCron.length > 0 ? rawCron : DEFAULT_RETENTION_SCHEDULE_CRON,
    commit: env.RETENTION_SCHEDULE_COMMIT === 'true',
  };
}
