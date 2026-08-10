import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { redactSensitiveText } from '../common/logging/redact';
import { RootConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_RECONCILE_LIMIT,
  buildTranscodeJobId,
} from './transcode.constants';
import { TRANSCODE_QUEUE } from './transcode.types';
import type { TranscodeQueue } from './transcode.types';

/**
 * Slice 11N: bounded, idempotent recovery for processing intent that was
 * durably recorded in Postgres (`Video.processingState = "queued"`) but
 * whose enqueue attempt may never have reached Redis — a temporary Redis
 * outage at `TranscodeIntentService.requestProcessing` time, or Redis being
 * unavailable/misconfigured for a stretch, or (once a worker slice exists) a
 * job that was silently dropped by BullMQ/Redis itself. "DB is the source of
 * truth" (proposal §8 / 2026-08-10 DECISIONS.md, item 6) means Redis loss
 * must never lose the underlying intent — this service is that recovery
 * mechanism.
 *
 * `reconcile` is a plain injectable method, deliberately NOT wired to any
 * cron/scheduler in this slice (no `@nestjs/schedule` decorator, unlike
 * `RetentionSchedulerService`'s existing pattern) — this slice's job is to
 * prove the reconciliation primitive itself is correct (idempotent, bounded,
 * never destructive, never stale); wiring it to run periodically belongs to
 * the worker slice that will actually consume these jobs, once there is a
 * real reason to run it on a schedule.
 *
 * Never touches `processingState` (a row this finds is already `"queued"`
 * and stays exactly that), never deletes anything, and NEVER enqueues a
 * version other than the row's CURRENT `processingVersion` — it always
 * re-reads the version fresh from the row it just queried, never a value it
 * cached from an earlier call, so a `requestProcessing` call that bumped the
 * version in between two `reconcile` sweeps is never silently superseded by
 * a stale re-enqueue.
 */
@Injectable()
export class TranscodeReconcilerService {
  private readonly logger = new Logger(TranscodeReconcilerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<RootConfig>,
    @Inject(TRANSCODE_QUEUE) private readonly queue: TranscodeQueue,
  ) {}

  /**
   * `limit` bounds a single sweep so a large backlog cannot turn one call
   * into an unbounded scan/enqueue burst — a future scheduler can call this
   * repeatedly (each call independently bounded) rather than this method
   * ever growing its own unbounded loop.
   *
   * Ordering: `orderBy: { id: 'asc' }` — a DETERMINISTIC (not a hard
   * dependency on true chronological insertion order) tie-break. `Video` has
   * no `createdAt` column (see the schema — deliberately not added by this
   * slice's schema-minimality constraint: 11N does not exercise it), so a
   * genuinely chronological "oldest request first" ordering is not
   * derivable without one. `id` ascending is stable and reproducible across
   * calls (the property `reconcile`'s own tests rely on — repeated sweeps
   * examine the backlog in the same order), which is what "bounded and
   * deterministic" actually requires for correctness here; it is a
   * documented, deliberate simplification, not an oversight, and a future
   * slice that adds a processing timestamp column may tighten this to true
   * chronological order without changing this method's contract.
   *
   * Flag off (`TRANSCODE_ENABLED` not `"true"`) is an immediate no-op —
   * zero Prisma queries, zero queue calls — matching every other flag-off
   * code path in this slice.
   */
  async reconcile(limit: number = DEFAULT_RECONCILE_LIMIT): Promise<number> {
    const transcodeConfig = this.configService.get('transcode', {
      infer: true,
    });

    if (!transcodeConfig?.enabled) {
      return 0;
    }

    const staleRows = await this.prisma.video.findMany({
      where: { processingState: 'queued' },
      orderBy: { id: 'asc' },
      take: limit,
      select: { id: true, processingVersion: true },
    });

    let reenqueuedCount = 0;

    for (const row of staleRows) {
      const jobId = buildTranscodeJobId(row.id, row.processingVersion);

      try {
        await this.queue.add(jobId, {
          videoId: row.id,
          processingVersion: row.processingVersion,
        });
        reenqueuedCount += 1;
      } catch (error) {
        this.logger.warn(
          redactSensitiveText(
            `Reconciler failed to re-enqueue transcode job "${jobId}" — will ` +
              `retry on the next sweep: ${String(error)}`,
          ),
        );
      }
    }

    return reenqueuedCount;
  }
}
