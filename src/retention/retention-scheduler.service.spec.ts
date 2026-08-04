import { Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import {
  RETENTION_CRON_JOB_NAME,
  RetentionSchedulerService,
} from './retention-scheduler.service';
import { RetentionService } from './retention.service';
import { RetentionReport } from './retention.types';

const FAKE_REPORT: RetentionReport = {
  generatedAt: new Date('2026-08-04T03:00:00.000Z'),
  commit: false,
  targets: [
    {
      target: 'session',
      cutoff: new Date('2026-05-06T03:00:00.000Z'),
      matchedCount: 3,
      deletedCount: 0,
    },
  ],
};

/**
 * Phase 13, work unit 13A-B2: behavioral coverage for
 * `RetentionSchedulerService` — registration is conditional on
 * `RETENTION_SCHEDULE_ENABLED`, the registered job uses the configured cron,
 * a tick passes the configured `commit` flag through to
 * `RetentionService.run` unchanged, a tick's report/error is logged through
 * the structured logger, and an invalid cron expression fails boot loudly.
 *
 * `RetentionService.run` is mocked on a real `RetentionService` instance
 * (never a hand-rolled fake) — the instance's `PrismaService` is
 * constructed but never `onModuleInit`-ed/`$connect()`-ed, so this spec
 * never touches a real database.
 *
 * Every test that calls `onModuleInit()` while enabled drives its tick
 * deterministically via the real `cron` package's own `fireOnTick()`
 * (`CronJob.from({ waitForCompletion: true, ... })` in the source — see its
 * doc comment) rather than waiting on a real timer, and `afterEach` always
 * calls `service.onModuleDestroy()` to stop/remove any job a test
 * registered — `job.start()` sets a real (if distant, given the default
 * daily cron) `setTimeout`, and leaving one running would hold the Jest
 * process open past this file's last test.
 *
 * **Non-vacuous-by-mutation proof (required by this work unit) — reported
 * in this work unit's handoff, not re-encoded as an automated check here,
 * mirroring the existing `run-retention-cli.spec.ts` precedent for the same
 * kind of proof:**
 *   1. `RETENTION_SCHEDULE_ENABLED`'s default: `retention-schedule.config.ts`'s
 *      `env.RETENTION_SCHEDULE_ENABLED === 'true'` was temporarily changed to
 *      `env.RETENTION_SCHEDULE_ENABLED !== 'false'` (unset -> enabled). The
 *      "registers no job when ... unset" test below failed as expected (and
 *      only that test); the source was then restored byte-for-byte and the
 *      full file was re-run green.
 *   2. `RETENTION_SCHEDULE_COMMIT`'s default: the same file's
 *      `env.RETENTION_SCHEDULE_COMMIT === 'true'` was temporarily changed to
 *      `env.RETENTION_SCHEDULE_COMMIT !== 'false'` (unset -> commit). The
 *      "performs a DRY run by default" test below failed as expected (and
 *      only that test); the source was then restored byte-for-byte and the
 *      full file was re-run green.
 */
describe('RetentionSchedulerService', () => {
  const ENV_KEYS = [
    'RETENTION_SCHEDULE_ENABLED',
    'RETENTION_SCHEDULE_CRON',
    'RETENTION_SCHEDULE_COMMIT',
  ] as const;
  const originalEnv = new Map<string, string | undefined>();

  let schedulerRegistry: SchedulerRegistry;
  let retentionService: RetentionService;
  let runSpy: jest.SpiedFunction<RetentionService['run']>;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let service: RetentionSchedulerService;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }

    schedulerRegistry = new SchedulerRegistry();
    retentionService = new RetentionService(new PrismaService());
    runSpy = jest.spyOn(retentionService, 'run').mockResolvedValue(FAKE_REPORT);
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    service = new RetentionSchedulerService(
      schedulerRegistry,
      retentionService,
    );
  });

  afterEach(() => {
    service.onModuleDestroy();

    for (const [key, value] of originalEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    jest.restoreAllMocks();
  });

  describe('disabled by default — zero retention jobs registered', () => {
    it('registers no job when RETENTION_SCHEDULE_ENABLED is unset', () => {
      service.onModuleInit();

      expect(schedulerRegistry.getCronJobs().size).toBe(0);
      expect(schedulerRegistry.doesExist('cron', RETENTION_CRON_JOB_NAME)).toBe(
        false,
      );
    });

    it.each(['1', 'TRUE', 'yes'])(
      'registers no job for the garbage value %j',
      (value) => {
        process.env.RETENTION_SCHEDULE_ENABLED = value;

        service.onModuleInit();

        expect(schedulerRegistry.getCronJobs().size).toBe(0);
      },
    );
  });

  describe('enabled ("true") registers exactly one job using the configured cron', () => {
    it('uses the default cron ("0 3 * * *") when RETENTION_SCHEDULE_CRON is unset', () => {
      process.env.RETENTION_SCHEDULE_ENABLED = 'true';

      service.onModuleInit();

      expect(schedulerRegistry.getCronJobs().size).toBe(1);
      const job = schedulerRegistry.getCronJob(RETENTION_CRON_JOB_NAME);
      expect(job.cronTime.source).toBe('0 3 * * *');
    });

    it('uses a configured cron expression', () => {
      process.env.RETENTION_SCHEDULE_ENABLED = 'true';
      process.env.RETENTION_SCHEDULE_CRON = '*/5 * * * *';

      service.onModuleInit();

      expect(schedulerRegistry.getCronJobs().size).toBe(1);
      const job = schedulerRegistry.getCronJob(RETENTION_CRON_JOB_NAME);
      expect(job.cronTime.source).toBe('*/5 * * * *');
    });
  });

  describe('a scheduled tick', () => {
    it('performs a DRY run by default (RetentionService.run receives {commit: false})', async () => {
      process.env.RETENTION_SCHEDULE_ENABLED = 'true';

      service.onModuleInit();
      const job = schedulerRegistry.getCronJob(RETENTION_CRON_JOB_NAME);
      await job.fireOnTick();

      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(runSpy).toHaveBeenCalledWith({ commit: false });
    });

    it('passes {commit: true} through unchanged in COMMIT mode', async () => {
      process.env.RETENTION_SCHEDULE_ENABLED = 'true';
      process.env.RETENTION_SCHEDULE_COMMIT = 'true';

      service.onModuleInit();
      const job = schedulerRegistry.getCronJob(RETENTION_CRON_JOB_NAME);
      await job.fireOnTick();

      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(runSpy).toHaveBeenCalledWith({ commit: true });
    });

    it('logs the RetentionReport (counts only) through the structured logger on success', async () => {
      process.env.RETENTION_SCHEDULE_ENABLED = 'true';

      service.onModuleInit();
      const job = schedulerRegistry.getCronJob(RETENTION_CRON_JOB_NAME);
      await job.fireOnTick();

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('"matchedCount":3'),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('scheduled_retention_run'),
      );
    });

    it('catches a run() rejection, logs it through the structured logger, and never lets it become an unhandled rejection', async () => {
      process.env.RETENTION_SCHEDULE_ENABLED = 'true';
      runSpy.mockReset();
      runSpy.mockRejectedValue(new Error('simulated retention failure'));

      service.onModuleInit();
      const job = schedulerRegistry.getCronJob(RETENTION_CRON_JOB_NAME);

      // If the rejection were NOT caught inside the tick, this `await`
      // itself would throw/reject the test — resolving proves it was
      // handled, not merely that a `.catch` exists somewhere unobserved.
      await expect(job.fireOnTick()).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('simulated retention failure'),
      );
    });

    it('catches the destructive-retention guard refusal in COMMIT mode without crashing', async () => {
      process.env.RETENTION_SCHEDULE_ENABLED = 'true';
      process.env.RETENTION_SCHEDULE_COMMIT = 'true';
      runSpy.mockReset();
      runSpy.mockRejectedValue(
        new Error(
          'Refusing to run retention cleanup destructively: NODE_ENV is not allowed',
        ),
      );

      service.onModuleInit();
      const job = schedulerRegistry.getCronJob(RETENTION_CRON_JOB_NAME);

      await expect(job.fireOnTick()).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Refusing to run retention cleanup destructively',
        ),
      );
    });
  });

  describe('RETENTION_SCHEDULE_CRON validation', () => {
    it('fails boot loudly for an invalid cron expression, registering no job', () => {
      process.env.RETENTION_SCHEDULE_ENABLED = 'true';
      process.env.RETENTION_SCHEDULE_CRON = 'not a cron expression';

      expect(() => service.onModuleInit()).toThrow();
      expect(schedulerRegistry.getCronJobs().size).toBe(0);
    });
  });

  describe('onModuleDestroy', () => {
    it('is a no-op when no job was ever registered', () => {
      expect(() => service.onModuleDestroy()).not.toThrow();
    });

    it('stops and removes the registered job', () => {
      process.env.RETENTION_SCHEDULE_ENABLED = 'true';
      service.onModuleInit();

      service.onModuleDestroy();

      expect(schedulerRegistry.getCronJobs().size).toBe(0);
    });
  });
});
