import { randomUUID } from 'crypto';
import { mkdtemp, readFile, readdir, rm } from 'fs/promises';
import { join } from 'path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { redactSensitiveText } from '../common/logging/redact';
import { RootConfig } from '../config/configuration';
import {
  buildSourceObjectKey,
  buildThumbnailObjectKey,
} from '../media/media-storage-key.util';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import {
  DEFAULT_THUMBNAIL_TIMESTAMP_SECONDS,
  DEFAULT_THUMBNAIL_WIDTH,
  THUMBNAIL_CONTENT_TYPE,
} from '../thumbnails/thumbnail.constants';
import { THUMBNAIL_CLIENT } from '../thumbnails/thumbnail.types';
import type { ThumbnailClient } from '../thumbnails/thumbnail.types';
import {
  HLS_INIT_SEGMENT_CONTENT_TYPE,
  HLS_MEDIA_SEGMENT_CONTENT_TYPE,
  HLS_PLAYLIST_CONTENT_TYPE,
  HLS_VARIANT_PLAYLIST_FILENAME,
} from './hls/hls.constants';
import { HLS_PROBE_CLIENT } from './hls/hls.types';
import type {
  HlsProbeClient,
  HlsRungArtifact,
  HlsSourceProbe,
} from './hls/hls.types';
import { HlsPackageValidator } from './hls/hls-package-validator.service';
import { HlsTranscodeService } from './hls/hls-transcode.service';
import {
  audioBitrateBps,
  CONTAINER_OVERHEAD_MULTIPLIER,
  MasterPlaylistService,
} from './hls/master-playlist.service';
import { computeRenditionLadder } from './hls/rendition-ladder';
import {
  buildHlsMasterPlaylistKey,
  buildHlsStagingPrefix,
  deriveGenerationName,
} from './hls-staging-key.util';
import { TranscodeIntentService } from './transcode-intent.service';
import {
  formatTranscodeJobEvent,
  stageForErrorCode,
  TranscodeJobLogEvent,
  TranscodeJobStage,
  TranscodeSupersededReason,
} from './transcode-job-log';
import { resolveWorkerTempRoot } from './transcode-temp';
import {
  buildTranscodeJobId,
  TRANSCODE_WORKER_TEMP_DIR_PREFIX,
} from './transcode.constants';
import {
  HlsRenditionSummary,
  TranscodeErrorCode,
  TranscodeJobOutcome,
  TranscodeJobPayload,
} from './transcode.types';

/**
 * Everything ONE delivery of ONE job needs, assembled once in `process`
 * after the claim succeeds and passed down by value.
 *
 * Deliberately a parameter object rather than instance state on the
 * `@Injectable()` singleton: with `TRANSCODE_WORKER_CONCURRENCY > 1` (VPS
 * DEPLOYMENT) the SAME processor instance runs several jobs at once, so any
 * per-job field stored on `this` would be silently shared between them —
 * the kind of bug that only appears on the operator's bigger box.
 */
interface TranscodeRunContext {
  videoId: string;
  processingVersion: number;
  /** Deterministic BullMQ job id — see `TranscodeJobLogEvent.jobId`. */
  jobId: string;
  /** The `v<version>-a<attempt>-<uuid>` segment of `stagingPrefix`. */
  generation: string;
  tempDir: string;
  stagingPrefix: string;
  uploadedKeys: string[];
  hadExistingPoster: boolean;
  isFinalAttempt: boolean;
  attempt: number;
  maxAttempts: number;
  startedAtMs: number;
}

/** Local source file name inside this job's own temp directory. */
const SOURCE_TEMP_FILENAME = 'source.mp4';
const POSTER_TEMP_FILENAME = 'poster.jpg';

/**
 * Internal control-flow signal ONLY — thrown from inside the
 * `onRungStart` hook passed to `HlsTranscodeService.transcodeAll` to break
 * out of its per-rung loop the instant a step-update CAS reports this
 * generation has been superseded, without needing `HlsTranscodeService`
 * itself to know anything about supersession. Always caught inside
 * `process()`; never escapes this file.
 */
class SupersededMidRunSignal extends Error {}

/**
 * Slice 11P — Production Transcoding Lifecycle (control workspace
 * DECISIONS.md "2026-08-10 — Slice 11P APPROVED..." entry; architecture:
 * `proposals/phase-11-hls-pipeline-proposal.md` §6-§8). The real per-job
 * consumer logic — everything a BullMQ `Worker` (`src/worker/transcode-worker.ts`)
 * does for one `{videoId, processingVersion}` delivery. Deliberately
 * PLAIN/injectable and framework-agnostic beyond Nest DI: no BullMQ import
 * anywhere in this file, so every test here calls `process()` directly with
 * fakes/mocks — a crash mid-job is simulated by making a fake dependency
 * throw, never by touching a real queue.
 *
 * ## Pipeline (one `process()` call = one job attempt)
 *
 * 1. Load the row; abort as `superseded` if it no longer exists, its
 *    `processingVersion` no longer matches the payload, or it is not
 *    currently `"queued"` (a duplicate/late delivery of an already-handled
 *    job).
 * 2. `TranscodeIntentService.claimRunning` — the CAS `queued -> running`
 *    (version- AND state-guarded); a `0` result means a race was lost
 *    (another delivery claimed it first) — abort as `superseded`.
 * 3. Attempt-cap check: if the freshly-claimed `processingAttempts` exceeds
 *    `TRANSCODE_MAX_ATTEMPTS`, CAS-fail immediately with
 *    `MAX_ATTEMPTS_EXCEEDED` — no FFmpeg work is ever started for an
 *    over-cap attempt (defense in depth beyond BullMQ's own `attempts`
 *    config, in case a reconciler/manual re-enqueue produced more delivery
 *    attempts than the queue itself would have allowed).
 * 4. Download `admin-media/<id>/source` to a fresh `fs.mkdtemp` temp
 *    directory (`StorageService.downloadObjectToFile`) — `SOURCE_MISSING`
 *    on failure.
 * 5. Probe (`HlsProbeClient`, the SAME injectable Slice 11O already proved)
 *    — `PROBE_FAILED` on failure; persist the result
 *    (`TranscodeIntentService.recordSourceProbe`), which is ALSO this
 *    pipeline's first post-download supersede checkpoint.
 * 6. Compute the ladder (`computeRenditionLadder`, Slice 11O's pure
 *    function — unchanged, reused as-is).
 * 7. Transcode every rung (`HlsTranscodeService.transcodeAll`, Slice 11O's
 *    "one rendition fails ⇒ whole job fails" service, reused as-is) — a
 *    `processingStep` update fires before each rung via the `onRungStart`
 *    hook this slice added to that method; a supersede detected there
 *    aborts the whole loop immediately via `SupersededMidRunSignal`.
 * 8. Build + write `master.m3u8` locally (`MasterPlaylistService`, Slice
 *    11O, unchanged).
 * 9. Upload EVERY artifact (master + every variant playlist + every
 *    init/media segment) to the fresh, immutable, UNIQUE staging prefix
 *    `admin-media/<id>/hls/v<version>-a<attempt>-<uuid>/`
 *    (`buildHlsStagingPrefix`) — every successfully uploaded key is tracked
 *    in `uploadedKeys` AS IT HAPPENS, specifically so a mid-upload crash
 *    (network error, process kill) leaves an accurate record of exactly
 *    what needs cleaning up (`abortOrFail` below always cleans exactly this
 *    list, never a broad prefix delete).
 * 10. Locally re-validate the package (`HlsPackageValidator`, Slice 11O,
 *     unchanged) AND bounded-HEAD-verify every uploaded key — either
 *     failure cleans up staging and CAS-fails the row; NEITHER ever reaches
 *     promotion.
 * 11. Poster: if the row had no `thumbnailImageKey` at job start, generate
 *     one (the injected `ThumbnailClient`, the SAME ffmpeg-backed client
 *     `ThumbnailsModule` already provides) and upload it to
 *     `admin-media/<id>/thumbnail` (`buildThumbnailObjectKey` — the SAME key
 *     an admin's own manual thumbnail upload uses). A poster failure here
 *     FAILS THE WHOLE JOB (frozen arch: publish needs a poster) — cleans up
 *     HLS staging (the poster upload itself, if it landed, is left in place;
 *     it is idempotent/overwritable by a future successful attempt, and is
 *     never treated as "staging" to be cleaned). If a poster already
 *     exists, this step is skipped entirely.
 * 12. FINAL ATOMIC PROMOTION (`TranscodeIntentService.promoteIfCurrent`) —
 *     the ONLY write path for `hlsMasterKey`/`hlsRenditions`/
 *     `transcodeProfileVersion`. A `0` result (superseded at the very last
 *     moment) cleans up this job's OWN staging and returns `superseded` —
 *     it NEVER touches whatever generation IS now live.
 *
 * Live/current generation (whatever the row's `hlsMasterKey` currently
 * points at when THIS job starts) is never written to or deleted by this
 * class at any point — every upload goes to a brand-new prefix, and every
 * cleanup call only ever deletes keys THIS job itself uploaded
 * (`uploadedKeys`), by exact key, never a prefix delete.
 */
@Injectable()
export class TranscodeJobProcessor {
  private readonly logger = new Logger(TranscodeJobProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<RootConfig>,
    private readonly intentService: TranscodeIntentService,
    private readonly storageService: StorageService,
    @Inject(HLS_PROBE_CLIENT) private readonly probeClient: HlsProbeClient,
    private readonly transcodeService: HlsTranscodeService,
    private readonly masterPlaylistService: MasterPlaylistService,
    private readonly validator: HlsPackageValidator,
    @Inject(THUMBNAIL_CLIENT)
    private readonly thumbnailClient: ThumbnailClient,
  ) {}

  async process(payload: TranscodeJobPayload): Promise<TranscodeJobOutcome> {
    const { videoId, processingVersion } = payload;
    const startedAtMs = Date.now();
    const jobId = buildTranscodeJobId(videoId, processingVersion);

    // Every pre-claim exit shares the same shape: no attempt was started, so
    // there is no generation and no stage beyond `claim`.
    const claimBoundaryEvent = (
      failureCategory: TranscodeSupersededReason,
    ): TranscodeJobLogEvent => ({
      videoId,
      jobId,
      generation: null,
      stage: 'claim',
      outcome: 'superseded',
      durationMs: Date.now() - startedAtMs,
      failureCategory,
    });

    const row = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: {
        processingVersion: true,
        processingState: true,
        processingAttempts: true,
        thumbnailImageKey: true,
      },
    });

    if (!row) {
      this.emit(claimBoundaryEvent('ROW_NOT_FOUND'));
      return { outcome: 'superseded', reason: 'ROW_NOT_FOUND' };
    }
    if (row.processingVersion !== processingVersion) {
      this.emit(claimBoundaryEvent('VERSION_MISMATCH'));
      return { outcome: 'superseded', reason: 'VERSION_MISMATCH' };
    }
    if (row.processingState !== 'queued') {
      this.emit(claimBoundaryEvent('NOT_QUEUED'));
      return { outcome: 'superseded', reason: 'NOT_QUEUED' };
    }

    const claimed = await this.intentService.claimRunning(
      videoId,
      processingVersion,
    );
    if (claimed === 0) {
      this.emit(claimBoundaryEvent('CLAIM_RACE_LOST'));
      return { outcome: 'superseded', reason: 'CLAIM_RACE_LOST' };
    }

    const attempt = row.processingAttempts + 1;
    const transcodeConfig = this.configService.get('transcode', {
      infer: true,
    })!;
    const maxAttempts = transcodeConfig.maxAttempts;

    if (attempt > maxAttempts) {
      await this.intentService.failWithError(
        videoId,
        processingVersion,
        'MAX_ATTEMPTS_EXCEEDED',
        `Exceeded the maximum of ${maxAttempts} processing attempt(s).`,
      );
      this.emit({
        videoId,
        jobId,
        generation: null,
        stage: 'claim',
        outcome: 'failed',
        durationMs: Date.now() - startedAtMs,
        failureCategory: 'MAX_ATTEMPTS_EXCEEDED',
        terminal: true,
        attempt,
        maxAttempts,
      });
      return {
        outcome: 'failed',
        errorCode: 'MAX_ATTEMPTS_EXCEEDED',
        terminal: true,
      };
    }

    // VPS DEPLOYMENT: the parent directory is operator-configurable
    // (`TRANSCODE_TEMP_DIR`) so a container can put multi-GB transcoding
    // scratch on a volume with real headroom instead of a small image
    // `/tmp`. `undefined` keeps the historical `os.tmpdir()` behavior
    // exactly. The per-job directory itself is still a fresh `mkdtemp`, so
    // concurrent jobs can never collide regardless of where the root is.
    const tempRoot = await resolveWorkerTempRoot(transcodeConfig.tempDir);
    const tempDir = await mkdtemp(
      join(tempRoot, TRANSCODE_WORKER_TEMP_DIR_PREFIX),
    );
    const stagingPrefix = buildHlsStagingPrefix(
      videoId,
      processingVersion,
      attempt,
      randomUUID(),
    );
    // The generation NAME is the last path segment of the staging prefix
    // (`v<version>-a<attempt>-<uuid>`) — derived from the prefix rather than
    // rebuilt from the same three inputs, so `buildHlsStagingPrefix` stays
    // the only place that formula exists and a log line can never disagree
    // with the R2 directory it claims to describe.
    const generation = deriveGenerationName(stagingPrefix);
    const uploadedKeys: string[] = [];
    const hadExistingPoster = row.thumbnailImageKey !== null;
    // This attempt is the LAST one the cap allows — a real pipeline failure
    // on THIS attempt goes straight to the TERMINAL `failWithError` CAS
    // (preserving the real, informative error code) rather than bouncing
    // back to `"queued"` via `requeueForRetry` only to immediately re-fail
    // with the less useful `MAX_ATTEMPTS_EXCEEDED` on a wasted extra cycle.
    const isFinalAttempt = attempt >= maxAttempts;

    const ctx: TranscodeRunContext = {
      videoId,
      processingVersion,
      jobId,
      generation,
      tempDir,
      stagingPrefix,
      uploadedKeys,
      hadExistingPoster,
      isFinalAttempt,
      attempt,
      maxAttempts,
      startedAtMs,
    };

    this.logger.log(
      redactSensitiveText(
        `Transcode job accepted: media "${videoId}" version ${processingVersion} attempt ${attempt}/${maxAttempts}.`,
      ),
    );
    this.emit({
      videoId,
      jobId,
      generation,
      stage: 'claim',
      outcome: 'accepted',
      durationMs: Date.now() - startedAtMs,
      attempt,
      maxAttempts,
    });

    try {
      return await this.runPipeline(ctx);
    } finally {
      // TEMP CLEANUP IS UNCONDITIONAL AND RUNS LAST. Every path that leaves
      // `runPipeline` — promoted, failed, superseded, or an unexpected throw
      // — has ALREADY captured this attempt's diagnostic state before
      // reaching here: `fail` writes the durable `processingErrorCode`/
      // `processingErrorMessage` to the row and emits the structured failure
      // event (stage, failure category, duration) first. Nothing
      // diagnostically useful lives only inside this directory by the time
      // it is removed, which is what makes an unconditional delete safe
      // rather than destructive — and what keeps a crash-looping job from
      // filling the disk with multi-GB scratch nobody will ever read.
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  /** Writes one structured lifecycle event (see `./transcode-job-log.ts`). */
  private emit(event: TranscodeJobLogEvent): void {
    this.logger.log(formatTranscodeJobEvent(event));
  }

  private async runPipeline(
    ctx: TranscodeRunContext,
  ): Promise<TranscodeJobOutcome> {
    const { videoId, processingVersion, tempDir, stagingPrefix, uploadedKeys } =
      ctx;
    const sourcePath = join(tempDir, SOURCE_TEMP_FILENAME);

    try {
      await this.storageService.downloadObjectToFile(
        buildSourceObjectKey(videoId),
        sourcePath,
      );
    } catch (error) {
      return this.fail(
        ctx,
        'SOURCE_MISSING',
        `Failed to download source object: ${briefMessage(error)}`,
      );
    }

    let probe: HlsSourceProbe;
    try {
      probe = await this.probeClient.probe(sourcePath);
    } catch (error) {
      return this.fail(
        ctx,
        'PROBE_FAILED',
        `ffprobe failed: ${briefMessage(error)}`,
      );
    }

    const probeRecorded = await this.intentService.recordSourceProbe(
      videoId,
      processingVersion,
      probe,
    );
    if (probeRecorded === 0) {
      return this.abortSuperseded(ctx);
    }

    const ladder = computeRenditionLadder(probe);
    const packageRoot = join(tempDir, 'package');

    let artifacts: HlsRungArtifact[];
    try {
      artifacts = await this.transcodeService.transcodeAll(
        sourcePath,
        packageRoot,
        ladder,
        async (rungName) => {
          const ok = await this.intentService.updateStep(
            videoId,
            processingVersion,
            rungName,
          );
          if (!ok) {
            throw new SupersededMidRunSignal();
          }
        },
      );
    } catch (error) {
      if (error instanceof SupersededMidRunSignal) {
        return this.abortSuperseded(ctx);
      }
      return this.fail(
        ctx,
        'TRANSCODE_FAILED',
        `HLS transcode failed: ${briefMessage(error)}`,
      );
    }

    const packagingStepOk = await this.intentService.updateStep(
      videoId,
      processingVersion,
      'packaging',
    );
    if (!packagingStepOk) {
      return this.abortSuperseded(ctx);
    }

    const masterBuild = this.masterPlaylistService.build(
      packageRoot,
      ladder,
      artifacts,
      probe.durationSeconds,
    );
    await this.masterPlaylistService.write(masterBuild);

    const uploadingStepOk = await this.intentService.updateStep(
      videoId,
      processingVersion,
      'uploading',
    );
    if (!uploadingStepOk) {
      return this.abortSuperseded(ctx);
    }

    try {
      await this.uploadPackage(
        packageRoot,
        stagingPrefix,
        artifacts,
        masterBuild.text,
        uploadedKeys,
      );
    } catch (error) {
      return this.fail(
        ctx,
        'UPLOAD_FAILED',
        `Uploading HLS artifacts failed: ${briefMessage(error)}`,
      );
    }

    const verifyingStepOk = await this.intentService.updateStep(
      videoId,
      processingVersion,
      'verifying',
    );
    if (!verifyingStepOk) {
      return this.abortSuperseded(ctx);
    }

    const validation = await this.validator.validate(
      packageRoot,
      ladder,
      artifacts,
      probe.durationSeconds,
      masterBuild.text,
    );
    if (!validation.valid) {
      return this.fail(
        ctx,
        'HLS_PACKAGE_VALIDATION_FAILED',
        `Local package validation failed: ${validation.issues.map((i) => i.code).join(', ')}`,
      );
    }

    const verified = await this.verifyUploadedKeys(uploadedKeys);
    if (!verified) {
      return this.fail(
        ctx,
        'UPLOAD_VERIFICATION_FAILED',
        'One or more uploaded HLS artifacts failed remote verification.',
      );
    }

    if (!ctx.hadExistingPoster) {
      const posterStepOk = await this.intentService.updateStep(
        videoId,
        processingVersion,
        'poster',
      );
      if (!posterStepOk) {
        return this.abortSuperseded(ctx);
      }

      let posterKey: string;
      try {
        posterKey = await this.generateAndUploadPoster(
          videoId,
          sourcePath,
          tempDir,
        );
      } catch (error) {
        return this.fail(
          ctx,
          'POSTER_GENERATION_FAILED',
          `Poster generation failed: ${briefMessage(error)}`,
        );
      }

      const posterRecorded = await this.intentService.recordPoster(
        videoId,
        processingVersion,
        posterKey,
      );
      if (posterRecorded === 0) {
        return this.abortSuperseded(ctx);
      }
    }

    const hlsMasterKey = buildHlsMasterPlaylistKey(stagingPrefix);
    const hlsRenditions = buildRenditionSummaries(
      artifacts,
      ladder.includeAudio,
    );

    const promoted = await this.intentService.promoteIfCurrent(
      videoId,
      processingVersion,
      {
        hlsMasterKey,
        hlsRenditions,
        transcodeProfileVersion: 'ladder-v1',
      },
    );

    if (promoted === 0) {
      return this.abortSuperseded(ctx, 'PROMOTION_RACE_LOST');
    }

    this.logger.log(
      redactSensitiveText(
        `Transcode job promoted: media "${videoId}" version ${processingVersion} ` +
          `— ${artifacts.length} rendition(s), ${(Date.now() - ctx.startedAtMs) / 1000}s wall-clock.`,
      ),
    );
    this.emit({
      videoId,
      jobId: ctx.jobId,
      generation: ctx.generation,
      stage: 'promote',
      outcome: 'promoted',
      durationMs: Date.now() - ctx.startedAtMs,
      attempt: ctx.attempt,
      maxAttempts: ctx.maxAttempts,
    });

    return { outcome: 'promoted', hlsMasterKey };
  }

  private async uploadPackage(
    packageRoot: string,
    stagingPrefix: string,
    artifacts: HlsRungArtifact[],
    masterPlaylistText: string,
    uploadedKeys: string[],
  ): Promise<void> {
    const masterKey = buildHlsMasterPlaylistKey(stagingPrefix);
    await this.storageService.putObject(
      masterKey,
      Buffer.from(masterPlaylistText, 'utf8'),
      HLS_PLAYLIST_CONTENT_TYPE,
    );
    uploadedKeys.push(masterKey);

    for (const artifact of artifacts) {
      const variantKey = `${stagingPrefix}${artifact.rung.name}/${HLS_VARIANT_PLAYLIST_FILENAME}`;
      const variantBody = await readFile(
        join(packageRoot, artifact.playlistRelativePath),
      );
      await this.storageService.putObject(
        variantKey,
        variantBody,
        HLS_PLAYLIST_CONTENT_TYPE,
      );
      uploadedKeys.push(variantKey);

      const entries = await readdir(artifact.outputDir);
      for (const entry of entries) {
        if (entry === HLS_VARIANT_PLAYLIST_FILENAME) {
          continue;
        }

        const contentType = entry.endsWith('.m4s')
          ? HLS_MEDIA_SEGMENT_CONTENT_TYPE
          : HLS_INIT_SEGMENT_CONTENT_TYPE;
        const body = await readFile(join(artifact.outputDir, entry));
        const key = `${stagingPrefix}${artifact.rung.name}/${entry}`;

        await this.storageService.putObject(key, body, contentType);
        uploadedKeys.push(key);
      }
    }
  }

  /** Bounded HEAD-verification of exactly the keys this job itself uploaded — never a broader listing. */
  private async verifyUploadedKeys(uploadedKeys: string[]): Promise<boolean> {
    for (const key of uploadedKeys) {
      const head = await this.storageService.headObject(key);
      if (!head || head.contentLength === 0) {
        return false;
      }
    }
    return true;
  }

  private async generateAndUploadPoster(
    videoId: string,
    sourcePath: string,
    tempDir: string,
  ): Promise<string> {
    const outputPath = join(tempDir, POSTER_TEMP_FILENAME);
    const artifact = await this.thumbnailClient.generate({
      inputPath: sourcePath,
      outputPath,
      timestampSeconds: DEFAULT_THUMBNAIL_TIMESTAMP_SECONDS,
      width: DEFAULT_THUMBNAIL_WIDTH,
    });

    const body = await readFile(artifact.outputPath);
    const key = buildThumbnailObjectKey(videoId);
    await this.storageService.putObject(key, body, THUMBNAIL_CONTENT_TYPE);

    return key;
  }

  /**
   * CAS-fails the row (own staging cleaned first) and returns a `failed`
   * outcome. Routes to the TERMINAL CAS (`failWithError`, `running ->
   * failed`) when `isFinalAttempt` is `true`, or the RETRYABLE CAS
   * (`requeueForRetry`, `running -> queued`) otherwise — see
   * `TranscodeJobOutcome`'s `terminal` field doc comment for how a caller
   * (the BullMQ wrapper) is expected to use this distinction.
   */
  private async fail(
    ctx: TranscodeRunContext,
    errorCode: TranscodeErrorCode,
    errorMessage: string,
  ): Promise<TranscodeJobOutcome> {
    const { videoId, processingVersion: expectedVersion, isFinalAttempt } = ctx;

    await this.cleanupKeys(ctx.uploadedKeys);

    this.logger.warn(
      redactSensitiveText(
        `Transcode job ${isFinalAttempt ? 'failed (terminal)' : 'failed (will retry)'}: ` +
          `media "${videoId}" version ${expectedVersion} — ${errorCode}: ${errorMessage}`,
      ),
    );
    // Emitted HERE, before the CAS write and long before `process`'s
    // `finally` removes the temp directory — the diagnostic state for this
    // attempt (which stage, which category, how long it ran) is durable in
    // the log stream no matter what the CAS below reports or how the
    // process ends afterwards.
    this.emit({
      videoId,
      jobId: ctx.jobId,
      generation: ctx.generation,
      stage: stageForErrorCode(errorCode),
      outcome: 'failed',
      durationMs: Date.now() - ctx.startedAtMs,
      failureCategory: errorCode,
      terminal: isFinalAttempt,
      attempt: ctx.attempt,
      maxAttempts: ctx.maxAttempts,
      errorDetail: errorMessage,
    });

    const affected = isFinalAttempt
      ? await this.intentService.failWithError(
          videoId,
          expectedVersion,
          errorCode,
          errorMessage,
        )
      : await this.intentService.requeueForRetry(
          videoId,
          expectedVersion,
          errorCode,
          errorMessage,
        );

    // If the CAS itself affected zero rows, this generation was superseded
    // between the failure occurring and this write — report the more
    // accurate outcome rather than claiming a `failed` write that never
    // actually landed.
    return affected > 0
      ? { outcome: 'failed', errorCode, terminal: isFinalAttempt }
      : { outcome: 'superseded', reason: 'SUPERSEDED_MID_RUN' };
  }

  /** Cleans up this job's own staging (no DB write) and returns a `superseded` outcome. */
  private async abortSuperseded(
    ctx: TranscodeRunContext,
    reason: 'SUPERSEDED_MID_RUN' | 'PROMOTION_RACE_LOST' = 'SUPERSEDED_MID_RUN',
    stage: TranscodeJobStage = 'promote',
  ): Promise<TranscodeJobOutcome> {
    await this.cleanupKeys(ctx.uploadedKeys);

    this.emit({
      videoId: ctx.videoId,
      jobId: ctx.jobId,
      generation: ctx.generation,
      stage,
      outcome: 'superseded',
      durationMs: Date.now() - ctx.startedAtMs,
      failureCategory: reason,
      attempt: ctx.attempt,
      maxAttempts: ctx.maxAttempts,
    });

    return { outcome: 'superseded', reason };
  }

  /**
   * Deletes exactly the keys THIS job itself uploaded — never a prefix/broad
   * delete. A per-key failure is logged loudly and does not abort the rest
   * (mirrors `HlsSmokeRunner`'s existing cleanup-failure precedent); an
   * unswept object here is still eventually reclaimed by
   * `TranscodeJanitorService.cleanupOrphanStaging` once its grace window
   * elapses.
   */
  private async cleanupKeys(keys: string[]): Promise<void> {
    for (const key of keys) {
      try {
        await this.storageService.deleteObject(key);
      } catch (error) {
        this.logger.error(
          redactSensitiveText(
            `Failed to clean up staging object "${key}" after an aborted transcode job: ${briefMessage(error)}`,
          ),
        );
      }
    }
  }
}

function buildRenditionSummaries(
  artifacts: HlsRungArtifact[],
  includeAudio: boolean,
): HlsRenditionSummary[] {
  return artifacts.map((artifact) => ({
    name: artifact.rung.name,
    width: artifact.rung.width,
    height: artifact.rung.height,
    bandwidth: Math.ceil(
      (artifact.rung.maxrateKbps * 1000 + audioBitrateBps(includeAudio)) *
        CONTAINER_OVERHEAD_MULTIPLIER,
    ),
  }));
}

/** Bound on `processingErrorMessage` — a real stack/URL is truncated well before it, never persisted whole. */
const MAX_ERROR_MESSAGE_LENGTH = 300;

/**
 * Redacted (via the shared `redactSensitiveText` layer — the SAME one every
 * other secret-adjacent log line in this codebase uses) AND length-bounded.
 * This is what actually reaches BOTH `Video.processingErrorMessage` (a
 * persisted, secret-free DB column — see its schema doc comment) and this
 * class's own log lines — a single redacted/bounded value, never a second,
 * un-redacted copy of the same underlying error text.
 */
function briefMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = redactSensitiveText(raw);
  return redacted.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${redacted.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
    : redacted;
}
