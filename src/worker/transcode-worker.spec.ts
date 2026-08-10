import { shouldRethrowForBullMqRetry } from './transcode-worker';
import { TranscodeJobOutcome } from '../transcode/transcode.types';

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
