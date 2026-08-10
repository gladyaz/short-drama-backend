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
