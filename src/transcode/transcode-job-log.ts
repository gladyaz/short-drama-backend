import { redactSensitiveText } from '../common/logging/redact';
import { TranscodeErrorCode, TranscodeJobOutcome } from './transcode.types';

/**
 * VPS DEPLOYMENT (work unit "TRANSCODE WORKER VPS DEPLOYMENT") — one
 * structured, machine-greppable line per transcode job lifecycle event.
 *
 * WHY A SECOND SHAPE ALONGSIDE THE EXISTING PROSE LOGS. The prose lines
 * `TranscodeJobProcessor` already writes are good for a human reading a
 * terminal and are deliberately kept. They are useless for the question an
 * operator of an UNATTENDED box actually asks — "which stage is failing
 * most, across every job, over the last day" — because answering it means
 * regex-ing a sentence whose wording is free to drift. These events carry
 * the same facts in fixed fields, so `docker logs ... | grep transcode.job |
 * jq` answers it directly (see `docs/TRANSCODE_WORKER_VPS.md`, "Logs").
 *
 * WHAT MUST NEVER APPEAR HERE. Every field below is an identifier, an
 * enum-like string, or a number — never a credential, never a signed URL,
 * never a raw error message. `errorDetail` is the one free-text field and it
 * is passed through `redactSensitiveText` along with the rest of the line,
 * which strips `Bearer` tokens, `user:password@` connection-string
 * credentials, sensitive `key: "value"` pairs, and `X-Amz-Signature`/
 * `X-Amz-Credential`/`X-Amz-Security-Token` presigned query parameters. R2
 * secrets and the Redis password never reach this layer at all: nothing in
 * the pipeline interpolates them into a message.
 */

/**
 * The pipeline stage an event belongs to. Mirrors the DB-visible
 * `processingStep` values `TranscodeIntentService.updateStep` writes
 * (`packaging`/`uploading`/`verifying`/`poster`) and names the three
 * boundaries that have no step of their own (`claim`, `download`, `probe`,
 * `promote`), so a stage in a log line and a stage in a stuck row are the
 * same vocabulary.
 */
export type TranscodeJobStage =
  | 'claim'
  | 'download'
  | 'probe'
  | 'transcode'
  | 'packaging'
  | 'uploading'
  | 'verifying'
  | 'poster'
  | 'promote';

/**
 * The reasons a delivery can end `superseded`. Derived from
 * `TranscodeJobOutcome` itself rather than restated, so a new reason added to
 * that union cannot silently become an untyped string in a log line.
 */
export type TranscodeSupersededReason = Extract<
  TranscodeJobOutcome,
  { outcome: 'superseded' }
>['reason'];

export interface TranscodeJobLogEvent {
  /** The media row being processed. */
  videoId: string;
  /**
   * The BullMQ job id. Recomputed deterministically from
   * `(videoId, processingVersion)` via `buildTranscodeJobId` rather than
   * threaded down from the `Worker` callback, because that function IS the
   * definition of a job's identity — the id in this field and the id an
   * operator sees in `bull:media-transcode:*` are the same string by
   * construction, not by convention.
   */
  jobId: string;
  /**
   * The HLS generation this attempt writes: the
   * `v<processingVersion>-a<attempt>-<uuid>` segment of its staging prefix,
   * i.e. exactly the directory name that appears in R2 and in `hlsMasterKey`.
   * `null` before an attempt has been claimed (a job rejected at the claim
   * boundary never allocates one).
   */
  generation: string | null;
  stage: TranscodeJobStage;
  outcome: 'accepted' | 'promoted' | 'failed' | 'superseded';
  /** Wall-clock milliseconds since this delivery was accepted. */
  durationMs: number;
  /**
   * The failure category — the same `TranscodeErrorCode` durably written to
   * the row, or a `superseded` reason. Absent on success.
   *
   * A CLOSED union on purpose (rather than widening to `string`): a
   * dashboard grouping by this field can only be correct if the set of
   * values it can hold is fixed and known.
   */
  failureCategory?: TranscodeErrorCode | TranscodeSupersededReason;
  /** Whether the row reached its TERMINAL failed state (no further retry). */
  terminal?: boolean;
  attempt?: number;
  maxAttempts?: number;
  /** Short, redacted failure detail. Never a stack trace, never a URL. */
  errorDetail?: string;
}

/** The fixed token every structured worker event line starts with. */
export const TRANSCODE_JOB_LOG_TAG = 'transcode.job';

/**
 * Renders one event as `transcode.job <json>` — a single line, greppable by
 * the tag, parseable by `jq` after stripping it.
 *
 * Undefined optional fields are omitted rather than serialized as `null`, so
 * a success line does not carry an empty `failureCategory` that a naive
 * dashboard would count as a failure.
 */
export function formatTranscodeJobEvent(event: TranscodeJobLogEvent): string {
  const payload = Object.fromEntries(
    Object.entries(event).filter(([, value]) => value !== undefined),
  );

  return redactSensitiveText(
    `${TRANSCODE_JOB_LOG_TAG} ${JSON.stringify(payload)}`,
  );
}

/**
 * Maps a durable error code to the pipeline stage that produces it.
 *
 * A lookup table rather than a `stage` argument threaded through every
 * `fail(...)` call site: the mapping is 1:1 and already fixed by the
 * pipeline's structure, so deriving it keeps the eight existing call sites
 * untouched and makes it impossible for a call site to report a stage that
 * contradicts its own error code.
 */
export function stageForErrorCode(
  errorCode: TranscodeErrorCode,
): TranscodeJobStage {
  switch (errorCode) {
    case 'SOURCE_MISSING':
      return 'download';
    case 'PROBE_FAILED':
      return 'probe';
    case 'TRANSCODE_FAILED':
      return 'transcode';
    case 'UPLOAD_FAILED':
      return 'uploading';
    case 'HLS_PACKAGE_VALIDATION_FAILED':
    case 'UPLOAD_VERIFICATION_FAILED':
      return 'verifying';
    case 'POSTER_GENERATION_FAILED':
      return 'poster';
    // `MAX_ATTEMPTS_EXCEEDED` and `STALE` are both decided at the claim
    // boundary (the attempt cap before any work starts; the janitor
    // CAS-failing a row whose worker died), and `DEMOTED` is an operator
    // action on an already-promoted generation — none of them is produced
    // by a pipeline stage doing work.
    case 'MAX_ATTEMPTS_EXCEEDED':
    case 'STALE':
    case 'DEMOTED':
    case 'UNKNOWN_ERROR':
      return 'claim';
  }
}
