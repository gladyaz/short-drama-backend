import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { redactSensitiveText } from '../common/logging/redact';
import { PrismaService } from '../prisma/prisma.service';
import { buildTranscodeJobId } from './transcode.constants';
import {
  HlsRenditionSummary,
  ProcessingState,
  TRANSCODE_QUEUE,
  TranscodeErrorCode,
} from './transcode.types';
import type { TranscodeQueue } from './transcode.types';

/**
 * Slice 11P: the narrow Prisma client surface every CAS write in this
 * service actually needs (`video.update`/`video.updateMany`) — satisfied by
 * BOTH a plain `PrismaService` (used outside a transaction, e.g.
 * `requestProcessing`'s own DB write) and a `Prisma.TransactionClient` (the
 * callback argument of `prisma.$transaction(async (tx) => ...)`, used by
 * `AdminMediaService.completeUpload`'s new transactional intent write — see
 * `recordIntent` below). Accepting this narrower type (rather than
 * `PrismaService` specifically) is what lets `recordIntent` run either
 * standalone or inside a caller-owned transaction with no code duplication.
 */
type PrismaWriteClient = Pick<Prisma.TransactionClient, 'video'>;

/**
 * Slice 11N — HLS Processing Data Model + Queue Foundation. The single
 * write path for `Video.processingState`/`processingVersion` today (a
 * future worker slice will add the second: the CAS transitions
 * `transitionIfVersion` performs). See the columns' schema doc comments in
 * `prisma/schema.prisma` for the full state-machine rationale.
 */
@Injectable()
export class TranscodeIntentService {
  private readonly logger = new Logger(TranscodeIntentService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(TRANSCODE_QUEUE) private readonly queue: TranscodeQueue,
  ) {}

  /**
   * The ONLY call site is `AdminMediaService.completeUpload`, itself guarded
   * by `TRANSCODE_ENABLED` at the call site (see that method's doc comment)
   * — this method does not re-check the flag, matching the 2026-08-10
   * DECISIONS.md approval's description of `requestProcessing` as an
   * unconditional atomic update.
   *
   * DB WRITE FIRST, ENQUEUE SECOND (binding design, proposal §8 / DECISIONS
   * item 6 — "DB is the source of truth"): a single Prisma `update` atomically
   * increments `processingVersion` and sets `processingState = "queued"` in
   * one SQL statement (`processingVersion: { increment: 1 }`, not a
   * read-then-write), so two concurrent calls against the same row race-safely
   * land on two DISTINCT, consecutive versions — never the same value twice,
   * and never lost. That write durably records processing intent regardless
   * of what happens next.
   *
   * The enqueue that follows is best-effort: `TranscodeQueue.add` uses the
   * deterministic `jobId = "<videoId>:<processingVersion>"` (BullMQ dedupe —
   * see `buildTranscodeJobId`), and any failure (Redis unreachable, Redis
   * never having been installed, etc.) is caught here, logged at `warn`
   * through the shared `redactSensitiveText` wrapper (so nothing about the
   * failure — e.g. a connection string embedded in an ioredis error message
   * — can leak a secret into logs), and NEVER rethrown. The DB row is left
   * exactly as `"queued"`: durable intent that
   * `TranscodeReconcilerService.reconcile` will pick up and retry later. The
   * caller (`AdminMediaService.completeUpload`) must never fail an otherwise
   * successful upload-completion merely because the queue is unavailable.
   *
   * Returns the new `processingVersion` (mostly useful to callers/tests that
   * want to assert on it — `AdminMediaService` itself does not need the
   * return value today).
   */
  async requestProcessing(videoId: string): Promise<number> {
    const processingVersion = await this.recordIntent(this.prisma, videoId);
    await this.enqueueBestEffort(videoId, processingVersion);

    return processingVersion;
  }

  /**
   * Slice 11P — RESOLVES the carried 11N/11O REQUIRED concern (control
   * workspace DECISIONS.md, "2026-08-10 — Slice 11P APPROVED..." entry,
   * binding constraint 5): the durable DB-write half of `requestProcessing`,
   * extracted so `AdminMediaService.completeUpload` can run it INSIDE the
   * SAME `prisma.$transaction` as the upload-completion ready-transition
   * (see that method's doc comment). `requestProcessing` above still calls
   * this standalone (passing `this.prisma` directly, which satisfies
   * `PrismaWriteClient`) — its own behavior, and every existing test that
   * exercises it directly, is completely unchanged by this refactor.
   *
   * Deliberately still just a single atomic `update` — same
   * `processingVersion: { increment: 1 }` race-safety property as before —
   * but now ALSO explicitly resets `processingStep`/`processingAttempts`/
   * `processingErrorCode`/`processingErrorMessage` to their "fresh
   * generation" values in the SAME write, so a brand-new
   * `processingVersion` never inherits progress/error detail left over from
   * a previous, unrelated generation of this row (e.g. a retried-and-failed
   * v1 must not leave `processingErrorCode` visible once v2 is queued).
   *
   * Takes `tx: PrismaWriteClient` (not `this.prisma` implicitly) so the
   * caller controls whether this runs standalone or inside a transaction —
   * see that type's doc comment.
   */
  async recordIntent(tx: PrismaWriteClient, videoId: string): Promise<number> {
    const updated = await tx.video.update({
      where: { id: videoId },
      data: {
        processingVersion: { increment: 1 },
        processingState: 'queued' satisfies ProcessingState,
        processingStep: null,
        processingAttempts: 0,
        processingErrorCode: null,
        processingErrorMessage: null,
      },
      select: { processingVersion: true },
    });

    return updated.processingVersion;
  }

  /**
   * Slice 11P: the best-effort enqueue half of `requestProcessing`,
   * extracted so `AdminMediaService.completeUpload` can call it AFTER its
   * transaction commits (proposal §8 / 2026-08-10 approval: "Enqueue stays
   * post-commit best-effort") — enqueueing before the durable intent is
   * actually committed would risk a worker picking up a job for a DB write
   * that never happened (or later rolled back). Never throws — identical
   * catch/redact/log-at-warn behavior to `requestProcessing`'s original
   * inline implementation; `TranscodeReconcilerService.reconcile` is the
   * recovery path for a failed enqueue here, exactly as before.
   */
  async enqueueBestEffort(
    videoId: string,
    processingVersion: number,
  ): Promise<void> {
    const jobId = buildTranscodeJobId(videoId, processingVersion);

    try {
      await this.queue.add(jobId, { videoId, processingVersion });
    } catch (error) {
      this.logger.warn(
        redactSensitiveText(
          `Failed to enqueue transcode job "${jobId}" — the video row stays ` +
            `"queued" and TranscodeReconcilerService.reconcile will retry ` +
            `the enqueue on its next sweep: ${String(error)}`,
        ),
      );
    }
  }

  /**
   * The generic compare-and-swap (CAS) primitive every future worker MUST
   * use to write `processingState` — a single guarded `updateMany`
   * (`processingVersion: expectedVersion`), never a plain `update` by id
   * alone. A stale/superseded `expectedVersion` (one that no longer matches
   * the row's CURRENT `processingVersion` — e.g. because a newer
   * `requestProcessing` call already ran) matches zero rows: the returned
   * count is `0`, and the row's `processingState` is left completely
   * untouched. This is what makes a duplicate/late worker attempt against a
   * superseded generation harmless instead of a silent data race.
   *
   * Slice 11N introduced this ahead of any real caller, specifically so
   * `it('a stale version affects zero rows')` could prove the version
   * counter works as a concurrency guard before anything depended on that
   * guarantee for real. Slice 11P is the first real caller — see
   * `TranscodeJanitorService.sweepStaleRunning` (the ONE remaining direct
   * caller; every OTHER 11P worker transition now uses one of the more
   * specific methods below, which additionally set the fields a bare
   * `processingState` write can't: `claimRunning`, `updateStep`,
   * `promoteIfCurrent`, `failWithError`).
   *
   * Deliberately version-only (no additional `processingState: { in: [...] }`
   * guard on the WHERE clause): the worker slice that actually knows the
   * full transition table (e.g. "running -> ready" is valid,
   * "ready -> running" is not) is better positioned to decide which specific
   * source states are acceptable for a given transition than this
   * foundational primitive is — adding an opinionated guess here would risk
   * being wrong in a way a future slice would have to work around rather
   * than extend. Version-only is a strict SUPERSET of safety today; a future
   * caller may layer a state guard on top by checking `nextState`/the row's
   * state before calling this, or this helper may grow an optional
   * `fromStates` parameter once a real worker's transition rules are known.
   */
  async transitionIfVersion(
    videoId: string,
    expectedVersion: number,
    nextState: ProcessingState,
  ): Promise<number> {
    const result = await this.prisma.video.updateMany({
      where: { id: videoId, processingVersion: expectedVersion },
      data: { processingState: nextState },
    });

    return result.count;
  }

  /**
   * Slice 11P — `TranscodeJobProcessor`'s claim step: `queued -> running`,
   * version-guarded AND additionally guarded on `processingState: "queued"`
   * (unlike the version-only `transitionIfVersion` above, this method DOES
   * know its exact transition table — it only ever claims a row that is
   * BOTH the expected version AND currently `"queued"`), so a second worker
   * racing to claim the same job (e.g. a duplicate BullMQ delivery) can never
   * both "win" — only the first `updateMany` to land actually matches a row;
   * the second affects zero rows. Sets `processingStartedAt` (telemetry +
   * `TranscodeJanitorService`'s stale-run detection basis) and increments
   * `processingAttempts` in the SAME write, and clears any error detail left
   * over from a prior attempt of THIS SAME generation (a retry within the
   * same `processingVersion` — a fresh generation via `recordIntent` already
   * clears these, but a retry of an already-`queued` generation goes through
   * THIS method again, not `recordIntent`).
   */
  async claimRunning(
    videoId: string,
    expectedVersion: number,
  ): Promise<number> {
    const result = await this.prisma.video.updateMany({
      where: {
        id: videoId,
        processingVersion: expectedVersion,
        processingState: 'queued' satisfies ProcessingState,
      },
      data: {
        processingState: 'running' satisfies ProcessingState,
        processingStep: 'probing',
        processingStartedAt: new Date(),
        processingAttempts: { increment: 1 },
        processingErrorCode: null,
        processingErrorMessage: null,
      },
    });

    return result.count;
  }

  /**
   * Slice 11P — records the display-only `processingStep` progress detail
   * (e.g. `"probing"`, a rung name, `"packaging"`, `"uploading"`,
   * `"verifying"`, `"poster"`), version- AND state-guarded (`"running"` —
   * only a row this job currently owns may have its step updated). A `0`
   * return means this generation was superseded (a newer `requestProcessing`
   * bumped the version) or otherwise left `"running"` mid-pipeline —
   * `TranscodeJobProcessor` treats that as an immediate signal to abort the
   * rest of the pipeline and clean up its own staging without touching the
   * row further (see that class's doc comment).
   */
  async updateStep(
    videoId: string,
    expectedVersion: number,
    step: string,
  ): Promise<number> {
    const result = await this.prisma.video.updateMany({
      where: {
        id: videoId,
        processingVersion: expectedVersion,
        processingState: 'running' satisfies ProcessingState,
      },
      data: { processingStep: step },
    });

    return result.count;
  }

  /**
   * Slice 11P — persists probed source metadata (informational/telemetry
   * only — see the four `Video.source*` columns' shared schema doc comment),
   * version- and state-guarded exactly like `updateStep`.
   */
  async recordSourceProbe(
    videoId: string,
    expectedVersion: number,
    probe: {
      width: number;
      height: number;
      durationSeconds: number;
      fps: number;
    },
  ): Promise<number> {
    const result = await this.prisma.video.updateMany({
      where: {
        id: videoId,
        processingVersion: expectedVersion,
        processingState: 'running' satisfies ProcessingState,
      },
      data: {
        sourceWidth: probe.width,
        sourceHeight: probe.height,
        sourceDurationSeconds: Math.round(probe.durationSeconds),
        sourceFps: probe.fps,
      },
    });

    return result.count;
  }

  /**
   * Slice 11P — records a newly generated poster's key, version- and
   * state-guarded exactly like `updateStep`. `TranscodeJobProcessor` calls
   * this only when the row had NO existing `thumbnailImageKey` at job start
   * (frozen arch: "if a poster already exists, skip" — an existing poster is
   * never regenerated or overwritten by this pipeline). Deliberately writes
   * `admin-media/<id>/thumbnail` (`buildThumbnailObjectKey`) — the SAME key
   * convention `AdminMediaService.createThumbnailUpload` already uses for a
   * manually-uploaded admin thumbnail — not `ThumbnailService`'s own
   * separate `thumbnails/<id>/<variant>.jpg` convention, so a generated
   * poster and a manually-uploaded one are indistinguishable to every other
   * reader of `Video.thumbnailImageKey`.
   */
  async recordPoster(
    videoId: string,
    expectedVersion: number,
    thumbnailImageKey: string,
  ): Promise<number> {
    const result = await this.prisma.video.updateMany({
      where: {
        id: videoId,
        processingVersion: expectedVersion,
        processingState: 'running' satisfies ProcessingState,
      },
      data: { thumbnailImageKey },
    });

    return result.count;
  }

  /**
   * Slice 11P — THE atomic pointer-flip promotion (2026-08-10 approval,
   * binding constraints 2/3/8): the ONLY write path for `hlsMasterKey`.
   * Version-guarded AND state-guarded on `"running"` — a stale/superseded
   * `expectedVersion`, or a row that is no longer `"running"` (e.g. already
   * flipped by a different attempt, or reset back to `"queued"`), matches
   * ZERO rows, and this method makes no partial write in that case: `count`
   * is `0` and NOTHING on the row changes — `hlsMasterKey` keeps pointing at
   * whatever the previous fully-verified generation was (or stays `null` if
   * there never was one). This is what makes "a crash after partial upload
   * leaves old live output intact" (proof 5) and "stale version cannot flip
   * live output" (proof 4) hold: the caller (`TranscodeJobProcessor`) MUST
   * have already fully verified the new generation (every rendition
   * transcoded, master playlist validated, every artifact HEAD-verified in
   * R2) before ever calling this — this method itself does not re-validate
   * anything, it only enforces ownership (id + version + state) atomically.
   */
  async promoteIfCurrent(
    videoId: string,
    expectedVersion: number,
    result: {
      hlsMasterKey: string;
      hlsRenditions: HlsRenditionSummary[];
      transcodeProfileVersion: string;
    },
  ): Promise<number> {
    const updated = await this.prisma.video.updateMany({
      where: {
        id: videoId,
        processingVersion: expectedVersion,
        processingState: 'running' satisfies ProcessingState,
      },
      data: {
        hlsMasterKey: result.hlsMasterKey,
        hlsRenditions: result.hlsRenditions as unknown as Prisma.InputJsonValue,
        transcodeProfileVersion: result.transcodeProfileVersion,
        processingState: 'ready' satisfies ProcessingState,
        processingStep: null,
        processingCompletedAt: new Date(),
      },
    });

    return updated.count;
  }

  /**
   * Slice 11P — the RETRYABLE failure CAS (`running -> queued`, NOT
   * terminal): used by `TranscodeJobProcessor` when a job-level failure
   * occurs on an attempt that has NOT yet exhausted `TRANSCODE_MAX_ATTEMPTS`
   * (proposal §8: "every attempt gets a fresh output prefix ... Retries:
   * 3 attempts, exponential backoff"). Version- AND state-guarded on
   * `"running"`, identically to `failWithError` below. Deliberately does
   * NOT reset `processingAttempts` (that counter must keep climbing across
   * retries of the SAME generation — resetting it here would let a
   * generation retry forever, defeating the whole point of the cap) and
   * does NOT set `processingCompletedAt` (this attempt did not reach a
   * terminal outcome). `processingErrorCode`/`processingErrorMessage` ARE
   * recorded — visible even while `"queued"` again, for anyone inspecting
   * the row between attempts — and are cleared the moment the NEXT
   * `claimRunning` call succeeds (that method's own `data` already nulls
   * both), so a successful retry never carries a stale error forward.
   */
  async requeueForRetry(
    videoId: string,
    expectedVersion: number,
    errorCode: TranscodeErrorCode,
    errorMessage: string,
  ): Promise<number> {
    const result = await this.prisma.video.updateMany({
      where: {
        id: videoId,
        processingVersion: expectedVersion,
        processingState: 'running' satisfies ProcessingState,
      },
      data: {
        processingState: 'queued' satisfies ProcessingState,
        processingStep: null,
        processingErrorCode: errorCode,
        processingErrorMessage: errorMessage,
      },
    });

    return result.count;
  }

  /**
   * Slice 11P — the TERMINAL failure CAS (`running -> failed`, no further
   * retries), used by `TranscodeJobProcessor` when an attempt fails AND it
   * was the FINAL allowed attempt (`MAX_ATTEMPTS_EXCEEDED`, or a real
   * pipeline failure — e.g. `TRANSCODE_FAILED` — on the last permitted
   * attempt), and by `TranscodeJanitorService.sweepStaleRunning` (`STALE`).
   * Version- AND state-guarded on `"running"` (a row must currently be owned by this
   * attempt to be failed by it) — a `0` return means the row already moved
   * on (promoted, or already failed/superseded by something else), so the
   * caller must NOT overwrite whatever state it is actually in. `errorCode`/
   * `errorMessage` are always short, bounded, SECRET-FREE values (see
   * `TranscodeErrorCode` and the column's own schema doc comment) — never a
   * raw exception message or stack trace.
   */
  async failWithError(
    videoId: string,
    expectedVersion: number,
    errorCode: TranscodeErrorCode,
    errorMessage: string,
  ): Promise<number> {
    const result = await this.prisma.video.updateMany({
      where: {
        id: videoId,
        processingVersion: expectedVersion,
        processingState: 'running' satisfies ProcessingState,
      },
      data: {
        processingState: 'failed' satisfies ProcessingState,
        processingStep: null,
        processingErrorCode: errorCode,
        processingErrorMessage: errorMessage,
        processingCompletedAt: new Date(),
      },
    });

    return result.count;
  }
}
