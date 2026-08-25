import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { redactSensitiveText } from '../common/logging/redact';
import {
  TRANSCODE_BACKOFF_BASE_DELAY_MS,
  TRANSCODE_QUEUE_NAME,
} from './transcode.constants';
import { TranscodeJobPayload, TranscodeQueue } from './transcode.types';

/**
 * Slice 11N: the real `TranscodeQueue` implementation, wrapping a single
 * BullMQ `Queue('media-transcode')`. `TranscodeModule`'s provider factory
 * constructs this class ONLY when `TRANSCODE_ENABLED` is exactly `"true"`
 * (2026-08-10 DECISIONS.md approval) — never as a fallback, never eagerly at
 * module-load time. No test in this repository constructs this class with a
 * real Redis endpoint; every test that needs `TRANSCODE_ENABLED=true`
 * behavior overrides the `TRANSCODE_QUEUE` DI token with a mock instead (see
 * `transcode.module.ts`'s doc comment), so this class's own `Queue`/
 * `IORedis` objects are never exercised against a live connection anywhere
 * in the test suite.
 *
 * `lazyConnect: true` on the underlying `IORedis` client means constructing
 * this class (and the `Queue` it wraps) does not, by itself, open a TCP
 * connection — the first real Redis command (the first `add` call) is what
 * triggers the actual connection attempt. `maxRetriesPerRequest: null` is
 * BullMQ's own documented requirement for the connection it is given (it
 * otherwise logs a runtime warning and overrides the option itself).
 *
 * Deliberately depends only on `bullmq` + `ioredis` (both real npm
 * dependencies of this repo — see the handoff notes on why `ioredis` had to
 * be installed explicitly alongside `bullmq`) — nothing here ever imports
 * `child_process`/`execFile`, ffmpeg, or ffprobe (see `no-ffmpeg.spec.ts`).
 *
 * Slice 11P: `maxAttempts` (from `TranscodeConfig.maxAttempts`, default 3)
 * is now passed through to every `queue.add` call as BullMQ's own `attempts`
 * job option, with exponential backoff off `TRANSCODE_BACKOFF_BASE_DELAY_MS`
 * (proposal §8: "3 attempts, exponential backoff (≈1 m → 5 m → 25 m)" —
 * BullMQ's `type: 'exponential'` backoff computes
 * `delay * 2^(attemptsMade - 1)`, so a 60 s base gives 60 s → 120 s → 240 s
 * for a 3-attempt job, comfortably inside that envelope while staying a
 * single, easily-adjusted constant). This is DELIBERATELY the queue-side
 * knob only — `TranscodeJobProcessor`'s own `processingAttempts` DB counter
 * and `TRANSCODE_MAX_ATTEMPTS` cap check are the AUTHORITATIVE source of
 * truth for "is this generation done retrying" (see that class's doc
 * comment), decoupled from whatever BullMQ's own internal counter does — a
 * mismatch between the two is harmless (a redundant extra delivery after our
 * own cap is hit is a cheap, idempotent no-op; see
 * `TranscodeJobProcessor.process`'s `NOT_QUEUED` superseded path).
 *
 * ## Shutdown (`OnModuleDestroy`)
 *
 * `lazyConnect` defers the FIRST connection, it does not prevent one: BullMQ's
 * `Queue` opens its own Redis connection as soon as it needs one, and that
 * socket is an open libuv handle that keeps the Node event loop alive forever
 * unless something closes it. Nothing did, so with `TRANSCODE_ENABLED=true`
 * every process that merely CONSTRUCTED this client — the API server, and
 * `scripts/hls-local-proof.ts` — finished all of its work, set `process
 * .exitCode`, and then hung indefinitely instead of exiting. That also defeated
 * the graceful-shutdown path added in `225c2ae`, which awaits `app.close()`.
 *
 * `onModuleDestroy` closes the `Queue` (which disconnects the connection BullMQ
 * itself created) and then quits the `IORedis` client this class constructed,
 * so `app.close()` releases every handle this client owns. Both steps are
 * best-effort and independently guarded: a shutdown-time Redis error must
 * never turn a clean exit into a crash, and a failure closing the queue must
 * not skip quitting the connection.
 */
@Injectable()
export class BullmqTranscodeQueueClient
  implements TranscodeQueue, OnModuleDestroy
{
  private readonly logger = new Logger(BullmqTranscodeQueueClient.name);
  private readonly queue: Queue<TranscodeJobPayload>;
  private readonly connection: IORedis;
  private readonly maxAttempts: number;

  constructor(redisUrl: string, maxAttempts: number) {
    const connection = new IORedis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
    });

    this.connection = connection;
    this.queue = new Queue<TranscodeJobPayload>(TRANSCODE_QUEUE_NAME, {
      connection,
    });
    this.maxAttempts = maxAttempts;
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.queue.close();
    } catch (error) {
      this.logger.warn(
        redactSensitiveText(
          `Failed to close the transcode queue during shutdown: ${String(error)}`,
        ),
      );
    }

    try {
      await this.connection.quit();
    } catch (error) {
      this.logger.warn(
        redactSensitiveText(
          `Failed to quit the transcode queue's Redis connection during shutdown: ${String(error)}`,
        ),
      );
    }
  }

  async add(jobId: string, payload: TranscodeJobPayload): Promise<void> {
    await this.queue.add(TRANSCODE_QUEUE_NAME, payload, {
      jobId,
      attempts: this.maxAttempts,
      backoff: {
        type: 'exponential',
        delay: TRANSCODE_BACKOFF_BASE_DELAY_MS,
      },
      // A worker (Slice 11P: `src/worker/transcode-worker.ts`) is the only
      // thing that ever removes a completed/failed job from the queue's own
      // bookkeeping. `removeOnComplete`/`removeOnFail` are left at BullMQ's
      // defaults deliberately — this repo's job volume is low enough that
      // unbounded queue-history growth is not yet a real operational
      // concern, and picking a retention policy without a real workload to
      // validate it against would be a guess, not a decision.
    });
  }
}
