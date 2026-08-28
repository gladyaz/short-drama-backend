import { deriveGenerationName } from './hls-staging-key.util';
import {
  formatTranscodeJobEvent,
  stageForErrorCode,
  TRANSCODE_JOB_LOG_TAG,
} from './transcode-job-log';
import { TranscodeErrorCode } from './transcode.types';

/**
 * VPS DEPLOYMENT — these lines are the only observability an unattended box
 * has. Two properties matter and both are asserted directly: the line is
 * MACHINE-PARSEABLE (so "which stage fails most" is a `jq` away rather than
 * a regex over prose), and it can never carry a secret.
 */
describe('formatTranscodeJobEvent', () => {
  const BASE = {
    videoId: 'video-104-02',
    jobId: 'video-104-02__v3',
    generation: 'v3-a1-2637db26',
    stage: 'transcode' as const,
    outcome: 'failed' as const,
    durationMs: 91_234,
  };

  function parse(line: string): Record<string, unknown> {
    expect(line.startsWith(`${TRANSCODE_JOB_LOG_TAG} `)).toBe(true);
    return JSON.parse(line.slice(TRANSCODE_JOB_LOG_TAG.length + 1)) as Record<
      string,
      unknown
    >;
  }

  it('emits a tagged, JSON-parseable line carrying every required field', () => {
    const payload = parse(
      formatTranscodeJobEvent({
        ...BASE,
        failureCategory: 'TRANSCODE_FAILED',
        terminal: false,
        attempt: 1,
        maxAttempts: 3,
      }),
    );

    expect(payload).toMatchObject({
      videoId: 'video-104-02',
      jobId: 'video-104-02__v3',
      generation: 'v3-a1-2637db26',
      stage: 'transcode',
      durationMs: 91_234,
      failureCategory: 'TRANSCODE_FAILED',
    });
  });

  // A success line carrying an empty `failureCategory` would be counted as a
  // failure by any naive dashboard built on these events.
  it('omits absent optional fields instead of serializing them as null', () => {
    const payload = parse(
      formatTranscodeJobEvent({
        ...BASE,
        stage: 'promote',
        outcome: 'promoted',
      }),
    );

    expect(payload).not.toHaveProperty('failureCategory');
    expect(payload).not.toHaveProperty('errorDetail');
    expect(payload).not.toHaveProperty('terminal');
  });

  it('keeps an explicit null generation (a job rejected before any attempt was claimed)', () => {
    const payload = parse(
      formatTranscodeJobEvent({
        ...BASE,
        generation: null,
        stage: 'claim',
        outcome: 'superseded',
        failureCategory: 'ROW_NOT_FOUND',
      }),
    );

    expect(payload.generation).toBeNull();
  });

  // THE PROHIBITION. `errorDetail` is the one free-text field, so it is the
  // one place a credential could ride in from a driver's own error message.
  it('redacts credentials embedded in a connection string in errorDetail', () => {
    const line = formatTranscodeJobEvent({
      ...BASE,
      failureCategory: 'UPLOAD_FAILED',
      errorDetail:
        'connect failed for redis://admin:hunter2@10.0.0.5:6379 while retrying',
    });

    expect(line).not.toContain('hunter2');
    expect(line).toContain('[REDACTED]');
  });

  it('redacts presigned-URL signing material in errorDetail', () => {
    const line = formatTranscodeJobEvent({
      ...BASE,
      failureCategory: 'SOURCE_MISSING',
      errorDetail:
        'GET https://acct.r2.cloudflarestorage.com/o?X-Amz-Signature=deadbeefcafe&X-Amz-Credential=AKIAEXAMPLE failed',
    });

    expect(line).not.toContain('deadbeefcafe');
    expect(line).not.toContain('AKIAEXAMPLE');
  });

  it('redacts a bearer token in errorDetail', () => {
    const line = formatTranscodeJobEvent({
      ...BASE,
      errorDetail: 'upstream rejected Authorization: Bearer abc.def.ghi',
    });

    expect(line).not.toContain('abc.def.ghi');
  });
});

describe('stageForErrorCode', () => {
  it.each<[TranscodeErrorCode, string]>([
    ['SOURCE_MISSING', 'download'],
    ['PROBE_FAILED', 'probe'],
    ['TRANSCODE_FAILED', 'transcode'],
    ['UPLOAD_FAILED', 'uploading'],
    ['HLS_PACKAGE_VALIDATION_FAILED', 'verifying'],
    ['UPLOAD_VERIFICATION_FAILED', 'verifying'],
    ['POSTER_GENERATION_FAILED', 'poster'],
    ['MAX_ATTEMPTS_EXCEEDED', 'claim'],
    ['STALE', 'claim'],
    ['DEMOTED', 'claim'],
    ['UNKNOWN_ERROR', 'claim'],
  ])('maps %s to the %s stage', (code, stage) => {
    expect(stageForErrorCode(code)).toBe(stage);
  });
});

/**
 * The generation NAME in a log line must be exactly the R2 directory name,
 * or an operator following a failure into the bucket looks in the wrong
 * place.
 */
describe('deriveGenerationName', () => {
  it('returns the final staging-prefix segment', () => {
    expect(
      deriveGenerationName('admin-media/video-1/hls/v3-a2-abc-uuid/'),
    ).toBe('v3-a2-abc-uuid');
  });

  it('tolerates a prefix with no trailing slash', () => {
    expect(deriveGenerationName('admin-media/video-1/hls/v3-a2-abc-uuid')).toBe(
      'v3-a2-abc-uuid',
    );
  });

  it('returns an empty string for an empty prefix rather than throwing', () => {
    expect(deriveGenerationName('')).toBe('');
  });
});
