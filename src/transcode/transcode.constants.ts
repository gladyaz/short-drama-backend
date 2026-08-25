/** Slice 11N: the single BullMQ queue name this whole module ever uses (proposal §8). */
export const TRANSCODE_QUEUE_NAME = 'media-transcode';

/**
 * Slice 11N: default bound for `TranscodeReconcilerService.reconcile` — a
 * deliberately small, safe sweep size (no scheduler wires this yet; see that
 * service's doc comment). Callers may override it.
 */
export const DEFAULT_RECONCILE_LIMIT = 25;

/**
 * The separator between the video id and the processing version in a
 * transcode jobId. Deliberately NOT `:`.
 *
 * BullMQ REJECTS a custom `jobId` containing `:` outright — `Job.addJob`
 * throws `Error: Custom Id cannot contain :` for any custom id that contains
 * a colon and does not split into exactly 3 colon-separated parts (that
 * 3-part carve-out exists only for backwards compatibility with old
 * repeatable-job ids; see `bullmq/dist/cjs/classes/job.js`). The original
 * `<videoId>:<processingVersion>` shape splits into 2 parts, so EVERY real
 * enqueue threw.
 *
 * That failure was invisible for two compounding reasons, which is why it
 * survived to a live run: `TranscodeIntentService.enqueueBestEffort`
 * deliberately catches and logs (never rethrows) every enqueue failure, so
 * the row was simply left `"queued"` forever; and every unit test
 * `jest.mock`s `bullmq` wholesale, so no test ever executed the real
 * validation that rejects the id. `TranscodeReconcilerService.reconcile`
 * could not recover it either — it rebuilds the SAME id and would fail
 * identically on every sweep, forever.
 */
export const TRANSCODE_JOB_ID_SEPARATOR = '__v';

/**
 * Deterministic BullMQ job identity: `<videoId>__v<processingVersion>`. The
 * SAME `(videoId, processingVersion)` pair always produces the SAME jobId,
 * which is what makes BullMQ's own duplicate-job suppression work as the
 * dedupe mechanism (proposal §8) — a second `add` call with an identical
 * jobId is a no-op on BullMQ's side, and `TranscodeReconcilerService` relies
 * on exactly this property to safely re-enqueue an already-queued row
 * without producing a second, distinct job.
 *
 * Only the SEPARATOR changed from the shape the proposal's prose names
 * (`<videoId>:<processingVersion>`) — see `TRANSCODE_JOB_ID_SEPARATOR` for
 * why a colon is impossible here. Every property the dedupe mechanism
 * actually depends on (determinism, and distinctness across both video id
 * and version) is unchanged, and nothing anywhere parses a jobId back apart
 * into its components — it is only ever produced and compared whole.
 */
export function buildTranscodeJobId(
  videoId: string,
  processingVersion: number,
): string {
  return `${videoId}${TRANSCODE_JOB_ID_SEPARATOR}${processingVersion}`;
}

/**
 * Slice 11P: default bound for both `TranscodeJanitorService` sweep methods
 * — mirrors `DEFAULT_RECONCILE_LIMIT`'s existing "small, safe, bounded per
 * call" rationale exactly.
 */
export const DEFAULT_JANITOR_SWEEP_LIMIT = 25;

/** `fs.mkdtemp` prefix for `TranscodeJobProcessor`'s own temp working directory. */
export const TRANSCODE_WORKER_TEMP_DIR_PREFIX = '11p-transcode-worker-';

/**
 * Slice 11P: base delay (ms) for BullMQ's `type: 'exponential'` job backoff
 * (`BullmqTranscodeQueueClient.add`) — proposal §8: "3 attempts, exponential
 * backoff (≈1 m → 5 m → 25 m)". See that class's doc comment for the exact
 * computed sequence.
 */
export const TRANSCODE_BACKOFF_BASE_DELAY_MS = 60_000;

/**
 * Slice 11P: BullMQ `Worker` concurrency for the transcode worker
 * (`src/worker/transcode-worker.ts`) — proposal §1/§13: "Concurrency 1 ...
 * so transcoding never starves the API" (this repo's prod v1 topology runs
 * API/Redis/worker as separate processes on one machine).
 */
export const TRANSCODE_WORKER_CONCURRENCY = 1;

/**
 * Slice 11P: how often (ms) BullMQ itself checks for stalled jobs
 * (`Worker`'s own `stalledInterval` option) — a complementary,
 * queue-level mechanism to `TranscodeJanitorService.sweepStaleRunning`'s
 * DB-level stale-row detection (that one recovers a row even if the
 * BullMQ-level stalled-job reclaim itself never fires, e.g. total Redis data
 * loss).
 */
export const TRANSCODE_WORKER_STALLED_INTERVAL_MS = 30_000;

/**
 * Slice 11P: how often (ms) `src/worker/main.ts`'s persistent-worker mode
 * calls `TranscodeJanitorService.sweepStaleRunning`/`cleanupOrphanStaging`.
 * Follows the Phase 13 (13A-B2) `RetentionSchedulerService` "env-gated
 * schedule OFF by default, injectable manual method is the real foundation"
 * precedent — see `TranscodeJanitorService`'s own doc comment for why this
 * slice reuses `TRANSCODE_ENABLED` itself as the single schedule gate
 * instead of introducing a second env var purely to control "does the
 * interval exist".
 */
export const TRANSCODE_JANITOR_INTERVAL_MS = 5 * 60_000;
