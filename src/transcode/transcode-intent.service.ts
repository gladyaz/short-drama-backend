import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSensitiveText } from '../common/logging/redact';
import { PrismaService } from '../prisma/prisma.service';
import { buildTranscodeJobId } from './transcode.constants';
import { ProcessingState, TRANSCODE_QUEUE } from './transcode.types';
import type { TranscodeQueue } from './transcode.types';

/**
 * Slice 11N — HLS Processing Data Model + Queue Foundation. The single
 * write path for `Video.processingState`/`processingVersion` today (a
 * future worker slice will add the second: the CAS transitions
 * `transitionIfVersion` performs). See the columns' schema doc comments in
 * `prisma/schema.prisma` for the full state-machine rationale.
 */
@Injectable()
export class TranscodeIntentService {
  private readonly logger = new Logger(TranscodeIntentService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(TRANSCODE_QUEUE) private readonly queue: TranscodeQueue,
  ) {}

  /**
   * The ONLY call site is `AdminMediaService.completeUpload`, itself guarded
   * by `TRANSCODE_ENABLED` at the call site (see that method's doc comment)
   * — this method does not re-check the flag, matching the 2026-08-10
   * DECISIONS.md approval's description of `requestProcessing` as an
   * unconditional atomic update.
   *
   * DB WRITE FIRST, ENQUEUE SECOND (binding design, proposal §8 / DECISIONS
   * item 6 — "DB is the source of truth"): a single Prisma `update` atomically
   * increments `processingVersion` and sets `processingState = "queued"` in
   * one SQL statement (`processingVersion: { increment: 1 }`, not a
   * read-then-write), so two concurrent calls against the same row race-safely
   * land on two DISTINCT, consecutive versions — never the same value twice,
   * and never lost. That write durably records processing intent regardless
   * of what happens next.
   *
   * The enqueue that follows is best-effort: `TranscodeQueue.add` uses the
   * deterministic `jobId = "<videoId>:<processingVersion>"` (BullMQ dedupe —
   * see `buildTranscodeJobId`), and any failure (Redis unreachable, Redis
   * never having been installed, etc.) is caught here, logged at `warn`
   * through the shared `redactSensitiveText` wrapper (so nothing about the
   * failure — e.g. a connection string embedded in an ioredis error message
   * — can leak a secret into logs), and NEVER rethrown. The DB row is left
   * exactly as `"queued"`: durable intent that
   * `TranscodeReconcilerService.reconcile` will pick up and retry later. The
   * caller (`AdminMediaService.completeUpload`) must never fail an otherwise
   * successful upload-completion merely because the queue is unavailable.
   *
   * Returns the new `processingVersion` (mostly useful to callers/tests that
   * want to assert on it — `AdminMediaService` itself does not need the
   * return value today).
   */
  async requestProcessing(videoId: string): Promise<number> {
    const updated = await this.prisma.video.update({
      where: { id: videoId },
      data: {
        processingVersion: { increment: 1 },
        processingState: 'queued' satisfies ProcessingState,
      },
      select: { processingVersion: true },
    });

    const processingVersion = updated.processingVersion;
    const jobId = buildTranscodeJobId(videoId, processingVersion);

    try {
      await this.queue.add(jobId, { videoId, processingVersion });
    } catch (error) {
      this.logger.warn(
        redactSensitiveText(
          `Failed to enqueue transcode job "${jobId}" — the video row stays ` +
            `"queued" and TranscodeReconcilerService.reconcile will retry ` +
            `the enqueue on its next sweep: ${String(error)}`,
        ),
      );
    }

    return processingVersion;
  }

  /**
   * The generic compare-and-swap (CAS) primitive every future worker MUST
   * use to write `processingState` — a single guarded `updateMany`
   * (`processingVersion: expectedVersion`), never a plain `update` by id
   * alone. A stale/superseded `expectedVersion` (one that no longer matches
   * the row's CURRENT `processingVersion` — e.g. because a newer
   * `requestProcessing` call already ran) matches zero rows: the returned
   * count is `0`, and the row's `processingState` is left completely
   * untouched. This is what makes a duplicate/late worker attempt against a
   * superseded generation harmless instead of a silent data race.
   *
   * No caller in this slice invokes this with `"running"`/`"ready"`/
   * `"failed"` yet — nothing in the repository produces those states today
   * (see `Video.processingState`'s schema doc comment). It exists now, ahead
   * of the worker that will use it, because a CAS primitive introduced
   * alongside the version counter it guards is the only way to prove (via
   * `it('a stale version affects zero rows')`, see
   * `transcode-intent.service.spec.ts`) that the counter actually works as a
   * concurrency guard BEFORE anything depends on that guarantee for real.
   *
   * Deliberately version-only (no additional `processingState: { in: [...] }`
   * guard on the WHERE clause): the worker slice that actually knows the
   * full transition table (e.g. "running -> ready" is valid,
   * "ready -> running" is not) is better positioned to decide which specific
   * source states are acceptable for a given transition than this
   * foundational primitive is — adding an opinionated guess here would risk
   * being wrong in a way a future slice would have to work around rather
   * than extend. Version-only is a strict SUPERSET of safety today; a future
   * caller may layer a state guard on top by checking `nextState`/the row's
   * state before calling this, or this helper may grow an optional
   * `fromStates` parameter once a real worker's transition rules are known.
   */
  async transitionIfVersion(
    videoId: string,
    expectedVersion: number,
    nextState: ProcessingState,
  ): Promise<number> {
    const result = await this.prisma.video.updateMany({
      where: { id: videoId, processingVersion: expectedVersion },
      data: { processingState: nextState },
    });

    return result.count;
  }
}
