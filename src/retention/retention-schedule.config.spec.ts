import {
  DEFAULT_RETENTION_SCHEDULE_CRON,
  RetentionScheduleConfig,
} from './retention-schedule.types';
import { resolveRetentionScheduleConfig } from './retention-schedule.config';

/**
 * Phase 13, work unit 13A-B2: unit coverage for the three
 * `RETENTION_SCHEDULE_*` env vars' parsing/defaulting rules. Entirely
 * in-memory — never touches `process.env` (an explicit `env` object is
 * passed to every call), so unlike some of this repo's other env-parsing
 * specs there is nothing to save/restore around each test.
 */
describe('resolveRetentionScheduleConfig', () => {
  const DISABLED_DRY_RUN_DEFAULT_CRON: RetentionScheduleConfig = {
    enabled: false,
    cronExpression: DEFAULT_RETENTION_SCHEDULE_CRON,
    commit: false,
  };

  describe('RETENTION_SCHEDULE_ENABLED (fail-closed — only the exact string "true" enables)', () => {
    it('is disabled when unset', () => {
      expect(resolveRetentionScheduleConfig({})).toEqual(
        DISABLED_DRY_RUN_DEFAULT_CRON,
      );
    });

    it.each(['', '1', 'TRUE', 'True', 'yes', 'false', 'enabled'])(
      'is disabled for the garbage value %j',
      (value) => {
        expect(
          resolveRetentionScheduleConfig({
            RETENTION_SCHEDULE_ENABLED: value,
          }).enabled,
        ).toBe(false);
      },
    );

    it('is enabled for exactly "true"', () => {
      expect(
        resolveRetentionScheduleConfig({
          RETENTION_SCHEDULE_ENABLED: 'true',
        }).enabled,
      ).toBe(true);
    });
  });

  describe('RETENTION_SCHEDULE_CRON', () => {
    it(`defaults to "${DEFAULT_RETENTION_SCHEDULE_CRON}" when unset`, () => {
      expect(resolveRetentionScheduleConfig({}).cronExpression).toBe(
        DEFAULT_RETENTION_SCHEDULE_CRON,
      );
    });

    it('defaults when set to a blank/whitespace-only string', () => {
      expect(
        resolveRetentionScheduleConfig({
          RETENTION_SCHEDULE_CRON: '   ',
        }).cronExpression,
      ).toBe(DEFAULT_RETENTION_SCHEDULE_CRON);
    });

    it('passes a configured expression through verbatim (trimmed)', () => {
      expect(
        resolveRetentionScheduleConfig({
          RETENTION_SCHEDULE_CRON: '  */5 * * * *  ',
        }).cronExpression,
      ).toBe('*/5 * * * *');
    });

    it("passes an INVALID expression through unchanged — validation is deliberately not this function's job", () => {
      expect(
        resolveRetentionScheduleConfig({
          RETENTION_SCHEDULE_CRON: 'not a cron expression',
        }).cronExpression,
      ).toBe('not a cron expression');
    });
  });

  describe('RETENTION_SCHEDULE_COMMIT (fail-closed — only the exact string "true" commits)', () => {
    it('is a dry run (commit=false) when unset', () => {
      expect(resolveRetentionScheduleConfig({}).commit).toBe(false);
    });

    it.each(['', '1', 'TRUE', 'True', 'yes', 'false', 'commit'])(
      'is a dry run for the garbage value %j',
      (value) => {
        expect(
          resolveRetentionScheduleConfig({
            RETENTION_SCHEDULE_COMMIT: value,
          }).commit,
        ).toBe(false);
      },
    );

    it('commits for exactly "true"', () => {
      expect(
        resolveRetentionScheduleConfig({
          RETENTION_SCHEDULE_COMMIT: 'true',
        }).commit,
      ).toBe(true);
    });
  });

  it('all three fields default together to disabled / dry-run / default cron', () => {
    expect(resolveRetentionScheduleConfig({})).toEqual(
      DISABLED_DRY_RUN_DEFAULT_CRON,
    );
  });

  it('defaults to the real process.env when no argument is passed', () => {
    const originalEnabled = process.env.RETENTION_SCHEDULE_ENABLED;
    delete process.env.RETENTION_SCHEDULE_ENABLED;

    try {
      expect(resolveRetentionScheduleConfig().enabled).toBe(false);
    } finally {
      if (originalEnabled === undefined) {
        delete process.env.RETENTION_SCHEDULE_ENABLED;
      } else {
        process.env.RETENTION_SCHEDULE_ENABLED = originalEnabled;
      }
    }
  });
});
