import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { redactSensitiveText } from '../common/logging/redact';
import { resolveRetentionScheduleConfig } from './retention-schedule.config';
import { RetentionService } from './retention.service';
import { RetentionReport } from './retention.types';

/** Name `RetentionSchedulerService` registers its cron job under in `SchedulerRegistry`. */
export const RETENTION_CRON_JOB_NAME = 'retention-cleanup';

/**
 * Phase 13, work unit 13A-B2 (closes the "scheduling is Phase 13's" earmark,
 * `TASK_QUEUE.md` follow-up item 15; approved `DECISIONS.md` 2026-08-04):
 * the in-app scheduler for `RetentionService`, which prior to this unit was
 * — by its own doc comment — never invoked except by hand via
 * `npm run retention`.
 *
 * **Registration is fully conditional, not decorator-based.** This
 * deliberately uses `@nestjs/schedule`'s DYNAMIC registration API
 * (`SchedulerRegistry.addCronJob`), not the `@Cron()` decorator, precisely
 * because a decorator-annotated method is ALWAYS registered as a job the
 * moment its class is instantiated — the only thing a decorator lets you
 * make conditional is what the job's BODY does once it fires, not whether
 * the job exists in `SchedulerRegistry` at all. This work unit's acceptance
 * criteria are explicit that when `RETENTION_SCHEDULE_ENABLED` is not
 * exactly `'true'`, ZERO retention cron jobs may exist — see
 * `onModuleInit` below, which returns before ever constructing a `CronJob`
 * in that case.
 *
 * **An invalid `RETENTION_SCHEDULE_CRON` fails boot loudly.** `new
 * CronJob(cronExpression, ...)` (the `cron` package, `@nestjs/schedule`'s own
 * dependency) validates `cronExpression` synchronously in its constructor and
 * THROWS for a malformed value. That throw is deliberately left uncaught in
 * `onModuleInit` — a Nest lifecycle hook throwing synchronously fails
 * `app.init()`/bootstrap, which is exactly "fail loudly at boot," the same
 * shape `env.validation.ts` already uses for a malformed `STORAGE_DRIVER`.
 *
 * **Commit mode stays double-gated.** When `RETENTION_SCHEDULE_COMMIT` is
 * exactly `'true'`, the scheduled tick calls
 * `RetentionService.run({ commit: true })`, which — UNCHANGED by this work
 * unit — calls `assertDestructiveRetentionAllowed()` as its own very first
 * action (`retention-env-guard.ts`) and throws outside
 * `development`/`test` + matching test-database identity. This file never
 * pre-checks or swallows that guard; it only catches whatever
 * `RetentionService.run` ultimately resolves or rejects with, exactly like
 * every other error a scheduled tick could produce (see
 * `runScheduledRetention` below).
 */
@Injectable()
export class RetentionSchedulerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RetentionSchedulerService.name);

  constructor(
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly retentionService: RetentionService,
  ) {}

  onModuleInit(): void {
    const config = resolveRetentionScheduleConfig();

    if (!config.enabled) {
      // Deliberately a plain early return, not a "registered but disabled"
      // job — see this class's doc comment: zero retention cron jobs may
      // exist in `SchedulerRegistry` at all when
      // `RETENTION_SCHEDULE_ENABLED` is not exactly `'true'`.
      return;
    }

    // `waitForCompletion: true` makes the underlying `cron` package's own
    // `fireOnTick()` actually AWAIT this tick's promise rather than firing
    // it and moving on — this matters for `retention-scheduler.service.spec.ts`,
    // which drives ticks deterministically via `fireOnTick()` instead of
    // waiting on a real timer, and needs that call to only resolve once
    // `runScheduledRetention` (below) has actually finished. It has no
    // production behavior implication beyond that: `runScheduledRetention`
    // already never rejects (see its own doc comment), so there is nothing
    // for a caller to "wait for" in the failure sense either way.
    const job = CronJob.from({
      cronTime: config.cronExpression,
      onTick: () => this.runScheduledRetention(config.commit),
      start: false,
      waitForCompletion: true,
      name: RETENTION_CRON_JOB_NAME,
    });

    this.schedulerRegistry.addCronJob(RETENTION_CRON_JOB_NAME, job);
    job.start();

    this.logger.log(
      `Scheduled retention job registered (cron="${config.cronExpression}", ` +
        `commit=${config.commit}).`,
    );
  }

  /**
   * Best-effort cleanup on graceful shutdown (`app.close()`). A no-op when
   * no job was ever registered (the default, disabled case) —
   * `SchedulerRegistry.doesExist` is checked first so this never throws
   * `NO_SCHEDULER_FOUND`.
   */
  onModuleDestroy(): void {
    if (this.schedulerRegistry.doesExist('cron', RETENTION_CRON_JOB_NAME)) {
      this.schedulerRegistry.deleteCronJob(RETENTION_CRON_JOB_NAME);
    }
  }

  /**
   * The actual per-tick job body — deliberately swallows EVERY error
   * `RetentionService.run` can produce, most notably the
   * `assertDestructiveRetentionAllowed()` throw a commit-mode tick still
   * produces outside `development`/`test` + matching test-database identity
   * (see this class's doc comment: that guard is neither bypassed nor
   * pre-checked here, only caught after the fact like any other rejection),
   * so a scheduled tick can NEVER crash the process or produce an unhandled
   * rejection. `SchedulerRegistry.addCronJob` also wraps `fireOnTick` in its
   * own generic try/catch as defense in depth, but relying on that alone
   * would log the raw, un-redacted error through `@nestjs/schedule`'s own
   * fallback logger — this method's own try/catch is what guarantees the
   * report or error is logged through this repo's `redactSensitiveText`
   * layer instead.
   */
  private async runScheduledRetention(commit: boolean): Promise<void> {
    try {
      const report = await this.retentionService.run({ commit });
      this.logger.log(
        redactSensitiveText(JSON.stringify(summarizeReport(report))),
      );
    } catch (error) {
      this.logger.error(
        redactSensitiveText(
          `Scheduled retention run failed: ${messageOf(error)}`,
        ),
      );
    }
  }
}

/**
 * Counts-only summary of a `RetentionReport` for the scheduled-run log line
 * — never row contents. `RetentionReport` itself never carries row contents
 * to begin with (see `retention.types.ts`); this additionally drops
 * `residueDetails`' per-model breakdown to keep the log line small, still
 * counts-only either way.
 */
function summarizeReport(report: RetentionReport): Record<string, unknown> {
  return {
    event: 'scheduled_retention_run',
    commit: report.commit,
    generatedAt: report.generatedAt.toISOString(),
    targets: report.targets.map((target) => ({
      target: target.target,
      matchedCount: target.matchedCount,
      deletedCount: target.deletedCount,
    })),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
