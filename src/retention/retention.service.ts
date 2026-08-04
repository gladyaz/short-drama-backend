import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertDestructiveRetentionAllowed } from './retention-env-guard';
import { processDeletedAccountResidue } from './retention-residue';
import {
  ANALYTICS_EVENT_RETENTION_DAYS,
  AUTH_AUDIT_EVENT_RETENTION_DAYS,
  PASSWORD_RESET_TOKEN_RETENTION_DAYS,
  SESSION_RETENTION_DAYS,
  WATCH_PROGRESS_RETENTION_DAYS,
} from './retention.constants';
import {
  RetentionReport,
  RetentionTargetReport,
  RunRetentionOptions,
} from './retention.types';
import { dayGranularityCutoff } from './retention.util';

/**
 * Phase 12, work unit 12D-B1: retention/cleanup jobs for expired sessions,
 * revoked-refresh-token rows past a window, `AuthAuditEvent`/`AnalyticsEvent`
 * TTL, deleted-account residue, and stale watch progress (see
 * `phases/phase-12.md` "12D — Privacy, retention & review sweep" and
 * `retention.constants.ts` for the per-target window reasoning; the
 * deleted-account-residue logic itself lives in `retention-residue.ts`, kept
 * separate purely for file-size/cohesion). Work unit 12E-B3 (`DECISIONS.md`
 * decision 3, 2026-07-30) added `PasswordResetToken` as a sixth target
 * (`processPasswordResetTokens` below) and remapped four of the numeric
 * windows in `retention.constants.ts` to human-decided values — see that
 * file's updated doc comments. `WATCH_PROGRESS_RETENTION_DAYS` and
 * `processWatchProgress` are unchanged by 12E-B3.
 *
 * **Update, Phase 13, work unit 13A-B2:** through Phase 12, this class was
 * deliberately NEVER imported by `AppModule`/`main.ts` — no `RetentionModule`
 * existed, and the only way to invoke it was the explicit, opt-in CLI script
 * below. That is no longer true: `RetentionModule` now exists, IS imported
 * by `AppModule`, and provides this class so `RetentionSchedulerService`
 * (`retention-scheduler.service.ts`) can invoke it on a schedule. There is
 * still no `@Cron` decorator on THIS class and no HTTP route anywhere
 * reaches it — the only two ways to invoke it remain (1) the explicit,
 * opt-in CLI script (`scripts/run-retention.ts`, `npm run retention`,
 * unchanged by this work unit) and (2) `RetentionSchedulerService`'s
 * cron job, which is itself DISABLED by default
 * (`RETENTION_SCHEDULE_ENABLED` must be exactly `'true'` for the job to be
 * registered at all) and, even when enabled, DRY-RUN by default
 * (`RETENTION_SCHEDULE_COMMIT` must be exactly `'true'` to pass
 * `commit: true` through) — see that class's own doc comment for the full
 * design and `retention-schedule.config.ts` for the exact env-var parsing.
 * The two guarantees below did not change in this work unit.
 *
 * **Dry run is the unconditional default.** `run()`/`buildReport()` with no
 * `commit: true` NEVER calls a single `deleteMany` — see each `process*`
 * method below, where the delete call is gated behind a plain
 * `commit ? await ... : 0` ternary, not a shared "maybe delete" helper that
 * could accidentally fire regardless of the flag. A caller who forgets to
 * pass `commit: true` gets only `count()`/read-only queries.
 *
 * **The production guard runs first, before any query.** `run()` calls
 * `assertDestructiveRetentionAllowed()` as its very first action whenever
 * `commit: true` is requested, before any of the five targets are processed —
 * so a refusal here means zero database activity happened for this call,
 * not merely "we decided not to delete after already reading the database."
 */
@Injectable()
export class RetentionService {
  constructor(private readonly prisma: PrismaService) {}

  /** Convenience alias for a dry run — identical to `run({ commit: false })`. */
  async buildReport(now: Date = new Date()): Promise<RetentionReport> {
    return this.run({ commit: false, now });
  }

  async run(options: RunRetentionOptions = {}): Promise<RetentionReport> {
    const commit = options.commit === true;
    const now = options.now ?? new Date();

    if (commit) {
      assertDestructiveRetentionAllowed();
    }

    const targets: RetentionTargetReport[] = [
      await this.processSessions(now, commit),
      await this.processPasswordResetTokens(now, commit),
      await this.processAuthAuditEvents(now, commit),
      await this.processAnalyticsEvents(now, commit),
      await this.processWatchProgress(now, commit),
      await processDeletedAccountResidue(this.prisma, commit),
    ];

    return { generatedAt: now, commit, targets };
  }

  /**
   * `Session` rows that can never be used again — see
   * `SESSION_RETENTION_DAYS`'s doc comment for the full "stale" definition
   * and the day-granularity rationale (the 12D-B0-inherited `revokedAt`
   * skew bound). Deliberately ONE combined `OR` predicate (not two separate
   * `deleteMany` calls), so a row matching both `revokedAt` and `expiresAt`
   * is never double-counted/double-processed.
   */
  private async processSessions(
    now: Date,
    commit: boolean,
  ): Promise<RetentionTargetReport> {
    const cutoff = dayGranularityCutoff(now, SESSION_RETENTION_DAYS);
    const where = {
      OR: [
        { revokedAt: { not: null, lt: cutoff } },
        { expiresAt: { lt: cutoff } },
      ],
    };

    const matchedCount = await this.prisma.session.count({ where });
    const deletedCount = commit
      ? (await this.prisma.session.deleteMany({ where })).count
      : 0;

    return { target: 'session', cutoff, matchedCount, deletedCount };
  }

  /**
   * `PasswordResetToken` TTL — Phase 12, work unit 12E-B3 (`DECISIONS.md`
   * decision 3, 2026-07-30). See `PASSWORD_RESET_TOKEN_RETENTION_DAYS`'s doc
   * comment for the full "stale" definition. Deliberately ONE combined `OR`
   * predicate (not two separate `deleteMany` calls), mirroring
   * `processSessions` above exactly — the same "never double-count a row
   * matching both branches" reasoning applies, on the `usedAt`/`expiresAt`
   * pair instead of `Session`'s `revokedAt`/`expiresAt` pair.
   */
  private async processPasswordResetTokens(
    now: Date,
    commit: boolean,
  ): Promise<RetentionTargetReport> {
    const cutoff = dayGranularityCutoff(
      now,
      PASSWORD_RESET_TOKEN_RETENTION_DAYS,
    );
    const where = {
      OR: [
        { usedAt: { not: null, lt: cutoff } },
        { expiresAt: { lt: cutoff } },
      ],
    };

    const matchedCount = await this.prisma.passwordResetToken.count({
      where,
    });
    const deletedCount = commit
      ? (await this.prisma.passwordResetToken.deleteMany({ where })).count
      : 0;

    return {
      target: 'passwordResetToken',
      cutoff,
      matchedCount,
      deletedCount,
    };
  }

  /**
   * `AuthAuditEvent` TTL — see `AUTH_AUDIT_EVENT_RETENTION_DAYS`'s doc
   * comment. Deliberately filters ONLY on `createdAt` (Prisma-typed,
   * `@default(now())`, never touched by the 12D-B0 raw-SQL bug), never on
   * `userId` — an anonymized, post-deletion row (scrubbed by 12E-B1's
   * `ipHash`/`userAgent`/`metadata` scrub, per `DECISIONS.md` 2026-07-30
   * decision 1 — `SetNull` alone is not sufficient for this table) and an
   * identified row age out on the exact same schedule, which is how
   * scrubbed rows are preserved for their full, intended retention window
   * rather than being singled out for early or late deletion.
   */
  private async processAuthAuditEvents(
    now: Date,
    commit: boolean,
  ): Promise<RetentionTargetReport> {
    const cutoff = dayGranularityCutoff(now, AUTH_AUDIT_EVENT_RETENTION_DAYS);
    const where = { createdAt: { lt: cutoff } };

    const matchedCount = await this.prisma.authAuditEvent.count({ where });
    const deletedCount = commit
      ? (await this.prisma.authAuditEvent.deleteMany({ where })).count
      : 0;

    return { target: 'authAuditEvent', cutoff, matchedCount, deletedCount };
  }

  /**
   * `AnalyticsEvent` TTL — see `ANALYTICS_EVENT_RETENTION_DAYS`'s doc
   * comment. Same "never filter on `userId`" property as `AuthAuditEvent`
   * above, and for the identical reason.
   */
  private async processAnalyticsEvents(
    now: Date,
    commit: boolean,
  ): Promise<RetentionTargetReport> {
    const cutoff = dayGranularityCutoff(now, ANALYTICS_EVENT_RETENTION_DAYS);
    const where = { receivedAt: { lt: cutoff } };

    const matchedCount = await this.prisma.analyticsEvent.count({ where });
    const deletedCount = commit
      ? (await this.prisma.analyticsEvent.deleteMany({ where })).count
      : 0;

    return { target: 'analyticsEvent', cutoff, matchedCount, deletedCount };
  }

  /**
   * `WatchProgress` — see `WATCH_PROGRESS_RETENTION_DAYS`'s doc comment for
   * why this window is deliberately the most conservative of the four (this
   * is the one target in this file that deletes genuinely user-visible
   * "resume where I left off" data, not backend bookkeeping/exhaust).
   */
  private async processWatchProgress(
    now: Date,
    commit: boolean,
  ): Promise<RetentionTargetReport> {
    const cutoff = dayGranularityCutoff(now, WATCH_PROGRESS_RETENTION_DAYS);
    const where = { updatedAt: { lt: cutoff } };

    const matchedCount = await this.prisma.watchProgress.count({ where });
    const deletedCount = commit
      ? (await this.prisma.watchProgress.deleteMany({ where })).count
      : 0;

    return { target: 'watchProgress', cutoff, matchedCount, deletedCount };
  }
}
