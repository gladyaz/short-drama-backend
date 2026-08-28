import { ProcessingState } from '../transcode/transcode.types';
import { MediaLifecycleState } from './media-lifecycle.types';

/**
 * Work unit "ADMIN MEDIA INGESTION": the single, authoritative PROJECTION a
 * dashboard reads to answer "where is this upload right now?".
 *
 * WHY A PROJECTION AND NOT A NEW COLUMN. Two independent state machines
 * already govern an admin media row, and both are load-bearing:
 *
 * - `Video.lifecycleState` — the EDITORIAL machine (`draft -> ready ->
 *   published <-> unpublished`, `* -> failed`), owned by
 *   `MediaLifecycleService`/`MEDIA_LIFECYCLE_TRANSITIONS`. It answers "may
 *   the public catalog serve this row?".
 * - `Video.processingState` — the HLS PIPELINE machine (`null -> queued ->
 *   running -> ready | failed`), owned by `TranscodeIntentService`'s CAS
 *   methods. It answers "has a playable HLS generation been produced?".
 *
 * Neither one alone tells an operator what the ingestion UI must show, and
 * adding a THIRD stored column would create exactly the duplicate state the
 * work unit forbids — a column that can silently disagree with the two that
 * actually drive behavior. So this module derives the answer, fresh, from
 * the two existing columns on every read. It is pure: it stores nothing,
 * writes nothing, and can never drift from the columns it reads.
 *
 * NAMING. Where the condition already has a real name in the schema, that
 * exact name is reused verbatim — `queued`, `running`, `ready`, `failed`
 * are `ProcessingState`'s own values, and `draft` is
 * `MediaLifecycleState.DRAFT`'s. Only two members are new, and only because
 * the condition they name genuinely had no prior name: `awaiting_upload`
 * (a draft row that HAS been issued a presigned PUT key but whose bytes
 * have not been verified yet) and `uploaded` (a finalized row that no HLS
 * pipeline has ever been requested for — every legacy/local row, and every
 * row completed while `TRANSCODE_ENABLED=false`).
 *
 * The dashboard's five display labels map onto these seven machine values:
 * "Uploading" = `draft`/`awaiting_upload`, "Queued" = `queued`/`uploaded`,
 * "Processing" = `running`, "Ready" = `ready`, "Failed" = `failed`.
 */
export const ADMIN_MEDIA_INGESTION_STATUSES = [
  'draft',
  'awaiting_upload',
  'uploaded',
  'queued',
  'running',
  'ready',
  'failed',
] as const;

export type AdminMediaIngestionStatus =
  (typeof ADMIN_MEDIA_INGESTION_STATUSES)[number];

/**
 * The two `MediaLifecycleState` members this module compares against, widened
 * to `string`.
 *
 * `Video.lifecycleState` is a plain `String` column (see its schema doc
 * comment for why it is not a Postgres enum), so the values compared here are
 * a `string` and a TypeScript enum member — a comparison
 * `@typescript-eslint/no-unsafe-enum-comparison` correctly flags, because in
 * general it can silently be always-false. Widening the enum members once,
 * here, keeps the comparison honest (string vs. string) while still deriving
 * the literals from the enum, so renaming a member cannot leave this module
 * comparing against a stale hardcoded string.
 */
const LIFECYCLE_FAILED: string = MediaLifecycleState.FAILED;
const LIFECYCLE_DRAFT: string = MediaLifecycleState.DRAFT;

/**
 * The exact, minimal set of columns `deriveIngestionStatus` reads. Declared
 * structurally (not as `VideoRow`) so this module stays a pure, dependency-
 * free function that both `AdminMediaService` and its own spec can call
 * with a plain object literal.
 */
export interface AdminMediaIngestionSource {
  lifecycleState: string;
  objectStorageKey: string | null;
  processingState: string | null;
}

/**
 * TOTAL — every `(lifecycleState, objectStorageKey, processingState)`
 * combination, including values neither enum can currently produce, maps to
 * exactly one status. Evaluation order is deliberate:
 *
 * 1. `lifecycleState === "failed"` wins outright. It is the terminal
 *    editorial state (`MEDIA_LIFECYCLE_TRANSITIONS` gives it no outgoing
 *    edges), so whatever the pipeline was doing is moot.
 * 2. `lifecycleState === "draft"` means the upload has NOT been verified
 *    yet — `AdminMediaService.completeUpload` is the only writer that moves
 *    a row off `draft`, and it does so only after R2's own `HeadObject`
 *    confirms the bytes. A draft row is therefore reported as still
 *    uploading regardless of `processingState`, which for such a row is
 *    always `null` anyway (nothing requests processing before completion).
 *    `objectStorageKey` separates "no upload has been started at all"
 *    (`draft`) from "a presigned key was issued and we are waiting for the
 *    bytes" (`awaiting_upload`).
 * 3. Otherwise the upload is finalized, and the pipeline column is the
 *    authoritative progress signal.
 *
 * An UNRECOGNISED `processingState` string (impossible through any current
 * write path — every writer uses a `satisfies ProcessingState` literal —
 * but the column is a plain `String` at rest) falls to `uploaded` rather
 * than throwing. Nothing is hidden by that choice: `AdminMediaProcessingDto`
 * reports the raw column value verbatim alongside this derived status, so
 * an operator still sees the real value.
 */
export function deriveIngestionStatus(
  row: AdminMediaIngestionSource,
): AdminMediaIngestionStatus {
  if (row.lifecycleState === LIFECYCLE_FAILED) {
    return 'failed';
  }

  if (row.lifecycleState === LIFECYCLE_DRAFT) {
    return row.objectStorageKey === null ? 'draft' : 'awaiting_upload';
  }

  switch (row.processingState as ProcessingState | null) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'ready':
      return 'ready';
    case 'failed':
      return 'failed';
    default:
      return 'uploaded';
  }
}

/**
 * Whether `POST /admin/media/:id/retry-transcode` would ACCEPT this row —
 * the same predicate `AdminMediaService.retryTranscode` enforces server-side,
 * exported here so a dashboard can enable/disable its Retry affordance from
 * the status payload instead of guessing (or discovering the answer only
 * from a 409).
 *
 * Deliberately NOT simply `status === "failed"`. A row can be `failed`
 * because the EDITORIAL machine failed it (`lifecycleState === "failed"`,
 * terminal) rather than because the pipeline did, and re-queueing a
 * transcode would be meaningless there. Only a row whose PIPELINE failed,
 * whose upload was actually finalized, and which still records a source key
 * is retryable.
 *
 * One condition intentionally cannot be represented here: whether the source
 * object still EXISTS in R2. That requires a `HeadObject` round trip, which
 * a DTO mapper must never make, so `retryTranscode` re-checks it server-side
 * and may still reject a row this predicate reports as retryable. The button
 * being enabled means "the server will consider this", not "this will
 * certainly succeed".
 */
export function canRetryTranscode(row: AdminMediaIngestionSource): boolean {
  return (
    row.processingState === ('failed' satisfies ProcessingState) &&
    row.lifecycleState !== LIFECYCLE_FAILED &&
    row.lifecycleState !== LIFECYCLE_DRAFT &&
    row.objectStorageKey !== null
  );
}
