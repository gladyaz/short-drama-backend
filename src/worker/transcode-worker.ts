import { Logger } from '@nestjs/common';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { redactSensitiveText } from '../common/logging/redact';
import { TranscodeJobProcessor } from '../transcode/transcode-job-processor.service';
import {
  TRANSCODE_QUEUE_NAME,
  TRANSCODE_WORKER_STALLED_INTERVAL_MS,
} from '../transcode/transcode.constants';
import {
  TranscodeJobOutcome,
  TranscodeJobPayload,
} from '../transcode/transcode.types';

const logger = new Logger('TranscodeWorker');

/**
 * The retry-decision logic documented in full on `startTranscodeWorker`
 * below, extracted as a PURE function so it is directly unit-testable
 * without ever constructing a real BullMQ `Worker` — the one piece of this
 * file's behavior that is not "just BullMQ wiring" and therefore genuinely
 * deserves its own test (see `transcode-worker.spec.ts`).
 */
export function shouldRethrowForBullMqRetry(
  outcome: TranscodeJobOutcome,
): boolean {
  return outcome.outcome === 'failed' && !outcome.terminal;
}

/**
 * Slice 11P — Production Transcoding Lifecycle (control workspace
 * DECISIONS.md "2026-08-10 — Slice 11P APPROVED..." entry; architecture:
 * `proposals/phase-11-hls-pipeline-proposal.md` §1/§8/§13). The thin BullMQ
 * `Worker` wiring — everything real job-processing logic lives in
 * `TranscodeJobProcessor` (constructed and exercised directly by every unit
 * test in that class's own spec, with fakes); this function's only job is to
 * connect that processor to a real `media-transcode` BullMQ queue.
 *
 * **Constructed LAZILY, and NEVER in a unit test.** `startTranscodeWorker`
 * is called from exactly one place: `src/worker/main.ts`'s flag-gated
 * persistent-worker mode (`TRANSCODE_ENABLED=true` only — the hard default
 * everywhere is `false`, per the 2026-08-10 approval's binding constraint
 * 13). Constructing a real BullMQ `Worker` opens a real Redis connection
 * attempt immediately (`Worker` is NOT lazy the way `Queue`'s underlying
 * `IORedis` client is configured to be in `BullmqTranscodeQueueClient`) — so
 * this function is never called from any test in this repository. A
 * simulated worker crash mid-job is exercised at the `TranscodeJobProcessor`
 * layer instead (a fake dependency throwing mid-pipeline), which is the
 * layer that actually needs to prove crash-safety; this file has no
 * additional state of its own to prove safe.
 *
 * **Retry/backoff is a queue-side (enqueue-time) concern, not a
 * Worker-side one** — BullMQ's `attempts`/`backoff` job options are set by
 * `BullmqTranscodeQueueClient.add` when a job is CREATED, not here. This
 * function's job is only to decide, PER DELIVERY (via
 * `shouldRethrowForBullMqRetry` above), whether to let a job resolve as
 * "done" (no more BullMQ-level retries) or re-throw (BullMQ applies the
 * job's own configured backoff and redelivers):
 *
 * - `outcome.outcome === 'promoted'` → resolve (success).
 * - `outcome.outcome === 'superseded'` → resolve (nothing to retry — a newer
 *   generation, or a lost claim race, already made this delivery moot).
 * - `outcome.outcome === 'failed' && outcome.terminal === true` → resolve
 *   (the row is already durably `"failed"` — `TranscodeJobProcessor` itself
 *   decided this was the last allowed attempt; no further BullMQ retry is
 *   wanted).
 * - `outcome.outcome === 'failed' && outcome.terminal === false` → THROW,
 *   so BullMQ's own backoff-driven redelivery fires for the SAME job. The
 *   row itself is already back to `"queued"` by this point
 *   (`TranscodeIntentService.requeueForRetry`), so the next delivery's
 *   `claimRunning` call succeeds normally.
 *
 * `concurrency` is now an explicit PARAMETER rather than a module
 * constant (VPS DEPLOYMENT, work unit "TRANSCODE WORKER VPS DEPLOYMENT").
 * `src/worker/main.ts` passes `TranscodeConfig.workerConcurrency`, whose
 * default is still `1` (proposal §1/§13: "so transcoding never starves the
 * API") and is never derived from the machine's CPU count — see
 * `DEFAULT_TRANSCODE_WORKER_CONCURRENCY` for why, and
 * `docs/TRANSCODE_WORKER_VPS.md` for per-VPS-size sizing guidance. Passing
 * it in rather than reading config here keeps this function a pure piece of
 * BullMQ wiring with no configuration dependency of its own.
 *
 * `stalledInterval` is BullMQ's OWN complementary stalled-job
 * detection, distinct from — and not a replacement for —
 * `TranscodeJanitorService.sweepStaleRunning`'s DB-level detection (that one
 * is the backstop for a scenario BullMQ's own mechanism cannot cover: total
 * Redis data loss, where BullMQ has no memory of the job at all but the DB
 * row is still durably `"running"`).
 */
export function startTranscodeWorker(
  redisUrl: string,
  processor: TranscodeJobProcessor,
  concurrency: number,
): Worker<TranscodeJobPayload> {
  const connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
  });

  const worker = new Worker<TranscodeJobPayload>(
    TRANSCODE_QUEUE_NAME,
    async (job) => {
      const outcome = await processor.process(job.data);

      logger.log(
        redactSensitiveText(
          `Job ${job.id ?? 'unknown'} (media "${job.data.videoId}" v${job.data.processingVersion}) ` +
            `resolved: ${JSON.stringify(outcome)}`,
        ),
      );

      // Deliberately re-checked with a direct narrowing condition (not just
      // `shouldRethrowForBullMqRetry(outcome)`) so TypeScript itself proves
      // `outcome.errorCode` is accessible below — see that function's own
      // doc comment for the single source of truth this mirrors exactly.
      if (outcome.outcome === 'failed' && !outcome.terminal) {
        throw new Error(
          `Transcode job failed (retryable): ${outcome.errorCode}`,
        );
      }

      return outcome;
    },
    {
      connection,
      concurrency,
      stalledInterval: TRANSCODE_WORKER_STALLED_INTERVAL_MS,
    },
  );

  worker.on('error', (error) => {
    logger.error(
      redactSensitiveText(`Transcode worker error: ${String(error)}`),
    );
  });

  worker.on('failed', (job, error) => {
    logger.warn(
      redactSensitiveText(
        `Job ${job?.id ?? 'unknown'} failed after BullMQ's own retry budget was exhausted: ${String(error)}`,
      ),
    );
  });

  return worker;
}
