import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { TRANSCODE_QUEUE_NAME } from './transcode.constants';
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
 */
@Injectable()
export class BullmqTranscodeQueueClient implements TranscodeQueue {
  private readonly queue: Queue<TranscodeJobPayload>;

  constructor(redisUrl: string) {
    const connection = new IORedis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
    });

    this.queue = new Queue<TranscodeJobPayload>(TRANSCODE_QUEUE_NAME, {
      connection,
    });
  }

  async add(jobId: string, payload: TranscodeJobPayload): Promise<void> {
    await this.queue.add(TRANSCODE_QUEUE_NAME, payload, {
      jobId,
      // A worker (a future slice) is the only thing that ever removes a
      // completed/failed job from the queue's own bookkeeping; this slice
      // creates no worker, so neither option is meaningful yet. Left at
      // BullMQ's defaults deliberately, rather than guessed at, so a future
      // worker slice picks retention policy deliberately instead of
      // inheriting an unreviewed default from here.
    });
  }
}
