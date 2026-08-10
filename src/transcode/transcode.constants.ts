/** Slice 11N: the single BullMQ queue name this whole module ever uses (proposal §8). */
export const TRANSCODE_QUEUE_NAME = 'media-transcode';

/**
 * Slice 11N: default bound for `TranscodeReconcilerService.reconcile` — a
 * deliberately small, safe sweep size (no scheduler wires this yet; see that
 * service's doc comment). Callers may override it.
 */
export const DEFAULT_RECONCILE_LIMIT = 25;

/**
 * Deterministic BullMQ job identity: `<videoId>:<processingVersion>`. The
 * SAME `(videoId, processingVersion)` pair always produces the SAME jobId,
 * which is what makes BullMQ's own duplicate-job suppression work as the
 * dedupe mechanism (proposal §8) — a second `add` call with an identical
 * jobId is a no-op on BullMQ's side, and `TranscodeReconcilerService` relies
 * on exactly this property to safely re-enqueue an already-queued row
 * without producing a second, distinct job.
 */
export function buildTranscodeJobId(
  videoId: string,
  processingVersion: number,
): string {
  return `${videoId}:${processingVersion}`;
}
