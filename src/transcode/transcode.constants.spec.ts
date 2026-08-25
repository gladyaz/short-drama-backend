import {
  buildTranscodeJobId,
  TRANSCODE_JOB_ID_SEPARATOR,
} from './transcode.constants';

describe('buildTranscodeJobId', () => {
  it('is deterministic — the same (videoId, processingVersion) pair always produces the same jobId', () => {
    expect(buildTranscodeJobId('media-abc', 3)).toBe(
      buildTranscodeJobId('media-abc', 3),
    );
  });

  it('produces distinct ids for distinct versions of the same video', () => {
    expect(buildTranscodeJobId('media-abc', 1)).not.toBe(
      buildTranscodeJobId('media-abc', 2),
    );
  });

  it('produces distinct ids for distinct videos at the same version', () => {
    expect(buildTranscodeJobId('media-abc', 1)).not.toBe(
      buildTranscodeJobId('media-xyz', 1),
    );
  });

  it('uses the exact "<videoId>__v<processingVersion>" shape', () => {
    expect(buildTranscodeJobId('media-abc', 7)).toBe('media-abc__v7');
  });

  /**
   * REGRESSION (found by the first real end-to-end run, never by a unit
   * test): BullMQ's `Job.addJob` throws `Custom Id cannot contain :` for any
   * custom jobId containing a colon that does not split into exactly 3
   * parts. The original `<videoId>:<processingVersion>` shape split into 2,
   * so every real `queue.add` threw — and because
   * `TranscodeIntentService.enqueueBestEffort` swallows enqueue failures by
   * design, and every other test `jest.mock`s `bullmq` wholesale, nothing
   * ever surfaced it. This asserts the property BullMQ actually enforces,
   * against a realistic id, rather than only the literal shape above.
   */
  it('never produces a jobId containing ":" — BullMQ rejects such ids outright', () => {
    const realisticIds = [
      buildTranscodeJobId('media-hlsproof-c8489b979862', 1),
      buildTranscodeJobId('media-54d5a084-bd85-4939-ba60-ab6534916a48', 12),
      buildTranscodeJobId('video-101-28', 3),
    ];

    for (const jobId of realisticIds) {
      expect(jobId).not.toContain(':');
    }
    expect(TRANSCODE_JOB_ID_SEPARATOR).not.toContain(':');
  });

  /**
   * BullMQ additionally rejects an all-integer custom id ("Custom Id cannot
   * be integers"). A video id is never numeric in this schema, but the
   * separator keeps the composed id non-numeric regardless.
   */
  it('never produces an all-integer jobId — BullMQ rejects those too', () => {
    expect(buildTranscodeJobId('123', 4)).not.toMatch(/^\d+$/);
  });
});
