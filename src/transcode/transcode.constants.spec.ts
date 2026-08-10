import { buildTranscodeJobId } from './transcode.constants';

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

  it('uses the exact "<videoId>:<processingVersion>" shape (proposal §8)', () => {
    expect(buildTranscodeJobId('media-abc', 7)).toBe('media-abc:7');
  });
});
