/**
 * Slice 11N — HLS Processing Data Model + Queue Foundation (control
 * workspace DECISIONS.md "2026-08-10 — Slice 11N APPROVED..." entry;
 * architecture: `proposals/phase-11-hls-pipeline-proposal.md` §8).
 *
 * The four app-layer-validated values `Video.processingState` may hold. NOT
 * a Postgres enum (see the column's schema doc comment for why — matches
 * this schema's existing `Video.category`/`lifecycleState` precedent).
 * `null` (a fifth, distinct "no pipeline for this row" case) is represented
 * by the column being nullable, not by a fifth member of this union.
 */
export type ProcessingState = 'queued' | 'running' | 'ready' | 'failed';

export const PROCESSING_STATES: readonly ProcessingState[] = [
  'queued',
  'running',
  'ready',
  'failed',
];

/**
 * The ONLY thing ever placed on the `media-transcode` queue — identifiers,
 * never bytes, never a presigned URL, never a credential (proposal §8, and
 * the 2026-08-10 DECISIONS.md approval, binding constraint 4). Intentionally
 * has exactly these two fields; a worker (a future slice) re-derives
 * everything else (source key, ladder, etc.) by reading the `Video` row
 * itself using `videoId`, keeping the queue payload minimal and stable even
 * as the row gains more processing-related columns later.
 */
export interface TranscodeJobPayload {
  videoId: string;
  processingVersion: number;
}

/**
 * Narrow injectable abstraction over the underlying queue technology,
 * mirroring this repo's existing `FfprobeClient`
 * (`src/importer/importer.types.ts`) / `ThumbnailClient`
 * (`src/thumbnails/thumbnail.types.ts`) injectable-client precedent.
 * `TranscodeModule` provides the real `BullmqTranscodeQueueClient` (wraps a
 * BullMQ `Queue`) ONLY when `TRANSCODE_ENABLED=true`; otherwise it provides
 * the inert `NoopTranscodeQueueClient` so no Redis connection is ever
 * attempted. Every test in this slice injects a mock implementation of this
 * interface directly — no test ever exercises the real BullMQ client
 * against a live Redis connection.
 */
export interface TranscodeQueue {
  add(jobId: string, payload: TranscodeJobPayload): Promise<void>;
}

/** DI token for the injected `TranscodeQueue`. */
export const TRANSCODE_QUEUE = 'TRANSCODE_TRANSCODE_QUEUE';

/**
 * Slice 11P — Production Transcoding Lifecycle. The shape persisted to
 * `Video.hlsRenditions` (a `Json?` column — see its schema doc comment) by
 * the promotion CAS (`TranscodeIntentService.promoteIfCurrent`), describing
 * ONLY the renditions actually produced for the CURRENT `hlsMasterKey`
 * generation. `bandwidth` mirrors the master playlist's `BANDWIDTH` value
 * (`MasterPlaylistService`, Slice 11O) — the peak, VBV-enforced bitrate in
 * bits/second, not a measured average.
 */
export interface HlsRenditionSummary {
  name: string;
  width: number;
  height: number;
  bandwidth: number;
}

/**
 * Slice 11P: the closed set of machine-stable codes
 * `Video.processingErrorCode` may hold, written exclusively by
 * `TranscodeJobProcessor` (a job-level failure) or `TranscodeJanitorService`
 * (`STALE`, a stalled-run detection). Never a raw exception message/stack —
 * see that column's schema doc comment.
 */
export type TranscodeErrorCode =
  | 'SOURCE_MISSING'
  | 'PROBE_FAILED'
  | 'TRANSCODE_FAILED'
  | 'UPLOAD_FAILED'
  | 'HLS_PACKAGE_VALIDATION_FAILED'
  | 'UPLOAD_VERIFICATION_FAILED'
  | 'POSTER_GENERATION_FAILED'
  | 'MAX_ATTEMPTS_EXCEEDED'
  | 'STALE'
  | 'UNKNOWN_ERROR';

/**
 * Slice 11P: the outcome `TranscodeJobProcessor.process` resolves with —
 * never throws for an expected/handled failure (matching this repo's
 * existing "structured result over exception for expected outcomes"
 * precedent, e.g. `HlsPackageValidationResult`) so a real BullMQ `Worker`
 * (or a test) can distinguish "ran to a terminal DB state" from "an
 * unexpected bug" without parsing error messages. A genuinely unexpected
 * throw (a bug, not a modeled failure) still propagates normally — BullMQ's
 * own retry/backoff handles that case at the queue layer.
 */
export type TranscodeJobOutcome =
  | { outcome: 'promoted'; hlsMasterKey: string }
  | {
      outcome: 'failed';
      errorCode: TranscodeErrorCode;
      /**
       * `true` when this was the FINAL allowed attempt (the row's DB state
       * is now the TERMINAL `"failed"` — a fresh `requestProcessing` call is
       * required to try again). `false` when the row was returned to
       * `"queued"` (`TranscodeIntentService.requeueForRetry`) so a future
       * claim (BullMQ's own backoff-driven redelivery of the SAME job, or a
       * `TranscodeReconcilerService.reconcile` sweep if that redelivery was
       * itself lost) can retry the SAME generation — see
       * `src/worker/transcode-worker.ts`'s doc comment for how this field
       * decides whether the BullMQ processor function re-throws (to
       * trigger BullMQ's own backoff) or resolves normally.
       */
      terminal: boolean;
    }
  | {
      outcome: 'superseded';
      reason:
        | 'ROW_NOT_FOUND'
        | 'VERSION_MISMATCH'
        | 'NOT_QUEUED'
        | 'CLAIM_RACE_LOST'
        | 'SUPERSEDED_MID_RUN'
        | 'PROMOTION_RACE_LOST';
    };
