import { Worker } from 'bullmq';
import {
  shouldRethrowForBullMqRetry,
  startTranscodeWorker,
} from './transcode-worker';
import { TranscodeJobProcessor } from '../transcode/transcode-job-processor.service';
import { TRANSCODE_QUEUE_NAME } from '../transcode/transcode.constants';
import { TranscodeJobOutcome } from '../transcode/transcode.types';

// Both are mocked wholesale so this file NEVER opens a real Redis
// connection — the reason `startTranscodeWorker` was previously left
// entirely untested (see its own doc comment). Mocking the two transports
// lets the one operator-facing property below be proven without relaxing
// that constraint at all.
jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation(() => ({ on: jest.fn() })),
}));
jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({})),
}));

/**
 * Slice 11P — `transcode-worker.ts`'s own doc comment explains why
 * `startTranscodeWorker` itself is never constructed in a unit test (it
 * opens a real Redis connection attempt immediately). This file covers the
 * one piece of genuinely testable logic that file contains: the
 * retry-vs-resolve decision BullMQ's processor callback makes per delivery.
 */
describe('shouldRethrowForBullMqRetry', () => {
  it('is true for a failed, non-terminal outcome (retryable — BullMQ should redeliver)', () => {
    const outcome: TranscodeJobOutcome = {
      outcome: 'failed',
      errorCode: 'TRANSCODE_FAILED',
      terminal: false,
    };

    expect(shouldRethrowForBullMqRetry(outcome)).toBe(true);
  });

  it('is false for a failed, terminal outcome (no further BullMQ retry wanted)', () => {
    const outcome: TranscodeJobOutcome = {
      outcome: 'failed',
      errorCode: 'MAX_ATTEMPTS_EXCEEDED',
      terminal: true,
    };

    expect(shouldRethrowForBullMqRetry(outcome)).toBe(false);
  });

  it('is false for a promoted outcome', () => {
    const outcome: TranscodeJobOutcome = {
      outcome: 'promoted',
      hlsMasterKey: 'admin-media/x/hls/v1-a1-uuid/master.m3u8',
    };

    expect(shouldRethrowForBullMqRetry(outcome)).toBe(false);
  });

  it.each<Extract<TranscodeJobOutcome, { outcome: 'superseded' }>['reason']>([
    'ROW_NOT_FOUND',
    'VERSION_MISMATCH',
    'NOT_QUEUED',
    'CLAIM_RACE_LOST',
    'SUPERSEDED_MID_RUN',
    'PROMOTION_RACE_LOST',
  ])('is false for a superseded outcome (reason: %s)', (reason) => {
    const outcome: TranscodeJobOutcome = { outcome: 'superseded', reason };

    expect(shouldRethrowForBullMqRetry(outcome)).toBe(false);
  });
});

/**
 * VPS DEPLOYMENT (work unit "TRANSCODE WORKER VPS DEPLOYMENT") — concurrency
 * is now an operator-set value rather than a compile-time constant, so the
 * one thing worth proving is that the number actually REACHES BullMQ.
 *
 * A break here is invisible in every other test and in the worker's own
 * startup log (which reports the config value, not what BullMQ received): an
 * operator would size a box, set the variable, watch the log confirm it, and
 * still get a single-threaded worker.
 */
describe('startTranscodeWorker — concurrency wiring', () => {
  const WorkerMock = Worker as unknown as jest.Mock;

  /** The BullMQ `Worker` constructor signature, as this file asserts against it. */
  type WorkerCall = [string, unknown, Record<string, unknown>];

  beforeEach(() => {
    WorkerMock.mockClear();
  });

  function firstWorkerCall(): WorkerCall {
    return (WorkerMock.mock.calls as WorkerCall[])[0];
  }

  function optionsForConcurrency(concurrency: number): Record<string, unknown> {
    startTranscodeWorker(
      'redis://localhost:6379',
      {} as unknown as TranscodeJobProcessor,
      concurrency,
    );

    return firstWorkerCall()[2];
  }

  it.each([1, 2, 4])(
    'passes the caller-supplied concurrency (%i) straight through to the BullMQ Worker',
    (concurrency) => {
      expect(optionsForConcurrency(concurrency)).toMatchObject({ concurrency });
    },
  );

  it('binds the worker to the single canonical transcode queue', () => {
    startTranscodeWorker(
      'redis://localhost:6379',
      {} as unknown as TranscodeJobProcessor,
      1,
    );

    expect(firstWorkerCall()[0]).toBe(TRANSCODE_QUEUE_NAME);
  });
});
