import { randomUUID } from 'crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppErrorCode } from '../../common/errors/app-error-code';
import { AppException } from '../../common/errors/app.exception';
import { redactSensitiveText } from '../../common/logging/redact';
import { StorageService } from '../../storage/storage.service';
import {
  HLS_INIT_SEGMENT_CONTENT_TYPE,
  HLS_MASTER_PLAYLIST_FILENAME,
  HLS_MEDIA_SEGMENT_CONTENT_TYPE,
  HLS_PACKAGE_TEMP_DIR_PREFIX,
  HLS_PLAYLIST_CONTENT_TYPE,
  HLS_SMOKE_KEY_PREFIX,
  HLS_VARIANT_PLAYLIST_FILENAME,
} from './hls.constants';
import { HlsPackageValidator } from './hls-package-validator.service';
import { HlsTranscodeService } from './hls-transcode.service';
import { MasterPlaylistService } from './master-playlist.service';
import { computeRenditionLadder } from './rendition-ladder';
import { SyntheticSourceService } from './synthetic-source.service';
import {
  HlsRungArtifact,
  HlsSmokeRunOptions,
  HlsSmokeRunResult,
  HlsUploadedObject,
} from './hls.types';

/**
 * Slice 11O — orchestrates generate → probe → ladder → transcode → master →
 * validate-locally → (gated-only) upload → verify → cleanup, per the
 * 2026-08-10 approval's stop condition ("implementation → offline validation
 * → independent review → implementation commit → ONE approved synthetic R2
 * proof → cleanup proof → control-workspace closeout → STOP").
 *
 * - **Local-only by default** (`options.upload` unset/`false`): every
 *   offline test and the local full-proof script use this path, which never
 *   constructs an upload key and never calls `StorageService`.
 * - **Upload path** (`options.upload: true`, used ONLY by the gated real-R2
 *   spec): runs ONLY after local validation passes; uploads every artifact
 *   under a fresh unique `_r2-hls-smoke-tests/<uuid>/` prefix (a fresh
 *   `randomUUID()` per run — the repo's established collision-resistant-id
 *   convention, see `../../media/admin-media.service.ts`'s `MEDIA_ID_PREFIX`
 *   pattern and 11K's smoke-test key construction — the immutable-staging
 *   architecture proposal's own text loosely calls this a "jobId cuid";
 *   this reuses the SAME id primitive already established in this repo
 *   rather than adding a new `cuid` dependency for an equivalent guarantee),
 *   then bounded-HEAD-verifies every uploaded object (count, non-zero size,
 *   Content-Type).
 * - **Cleanup is unconditional** (`finally`): local temp directories are
 *   always removed, and — when any object was uploaded — every RECORDED
 *   key (never a broad/prefix delete; `StorageService` has no
 *   list-by-prefix surface, so cleanup uses ONLY the in-memory
 *   `uploadedObjects` list built up as uploads succeed) is deleted and
 *   HEAD-verified gone. An unprovable cleanup (a delete or a post-delete
 *   HEAD that still resolves) is ALWAYS logged loudly, and additionally
 *   thrown as a surfaced error when it is the ONLY thing that went wrong
 *   (i.e. the run would otherwise have succeeded) — a cleanup failure is
 *   never silently swallowed, but it also never masks an earlier, more
 *   fundamental failure (e.g. a transcode error) that was already
 *   propagating.
 */
@Injectable()
export class HlsSmokeRunner {
  private readonly logger = new Logger(HlsSmokeRunner.name);

  constructor(
    private readonly syntheticSourceService: SyntheticSourceService,
    private readonly transcodeService: HlsTranscodeService,
    private readonly masterPlaylistService: MasterPlaylistService,
    private readonly validator: HlsPackageValidator,
    private readonly storageService: StorageService,
  ) {}

  async run(options: HlsSmokeRunOptions = {}): Promise<HlsSmokeRunResult> {
    const startedAt = Date.now();
    const upload = options.upload ?? false;

    const source = await this.syntheticSourceService.generate();
    const packageRoot = await mkdtemp(
      join(tmpdir(), HLS_PACKAGE_TEMP_DIR_PREFIX),
    );
    const uploadedObjects: HlsUploadedObject[] = [];
    let result: HlsSmokeRunResult | undefined;
    let cleanupError: AppException | undefined;

    try {
      const ladder = computeRenditionLadder(source.probe);
      const artifacts = await this.transcodeService.transcodeAll(
        source.sourcePath,
        packageRoot,
        ladder,
      );

      const masterBuild = this.masterPlaylistService.build(
        packageRoot,
        ladder,
        artifacts,
        source.probe.durationSeconds,
      );
      await this.masterPlaylistService.write(masterBuild);

      const validation = await this.validator.validate(
        packageRoot,
        ladder,
        artifacts,
        source.probe.durationSeconds,
        masterBuild.text,
      );

      const { totalLocalBytes, totalLocalFileCount } =
        await measureDirectory(packageRoot);

      let uploadResult: HlsSmokeRunResult['upload'];

      if (upload) {
        if (!validation.valid) {
          throw new AppException(
            AppErrorCode.HLS_PACKAGE_VALIDATION_FAILED,
            `Local HLS package validation failed (${validation.issues.length} issue(s)) — refusing to upload to R2`,
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }

        const keyPrefix = `${HLS_SMOKE_KEY_PREFIX}${randomUUID()}/`;
        const verified = await this.uploadAndVerify(
          packageRoot,
          keyPrefix,
          artifacts,
          uploadedObjects,
        );

        uploadResult = {
          keyPrefix,
          uploadedObjects: [...uploadedObjects],
          verified,
          cleanedUp: false,
          cleanupIssues: [],
        };
      }

      result = {
        sourcePath: source.sourcePath,
        sourceProbe: source.probe,
        ladder,
        packageRoot,
        masterPlaylistPath: masterBuild.path,
        masterPlaylistText: masterBuild.text,
        rungArtifacts: artifacts,
        validation,
        totalLocalBytes,
        totalLocalFileCount,
        wallClockMs: Date.now() - startedAt,
        upload: uploadResult,
      };

      // Deliberately NOT `return`ed here (would trip `no-unsafe-finally`'s
      // underlying concern once combined with the `finally` block below) —
      // `result` is read back after the `try`/`finally` statement completes.
    } finally {
      const cleanupIssues = await this.cleanupUploadedObjects(uploadedObjects);

      if (cleanupIssues.length > 0) {
        this.logger.error(
          redactSensitiveText(
            `HLS smoke run cleanup could NOT be fully proven — ${cleanupIssues.length} issue(s): ${cleanupIssues.join(' | ')}`,
          ),
        );
      }

      if (result?.upload) {
        result.upload.cleanedUp = cleanupIssues.length === 0;
        result.upload.cleanupIssues = cleanupIssues;
      }

      await rm(source.tempDir, { recursive: true, force: true });
      await rm(packageRoot, { recursive: true, force: true });

      // Only flag a cleanup-specific error when the run would OTHERWISE have
      // succeeded (`result` was assigned) — never mask an earlier, more
      // fundamental error already propagating out of the `try` block. This
      // sets `cleanupError` rather than throwing directly from `finally`
      // (ESLint `no-unsafe-finally`): a `throw` here would unconditionally
      // override whatever the `try` block was doing, including a real
      // in-flight exception, which is exactly the footgun that rule guards
      // against — `cleanupError` is checked and thrown AFTER this
      // `try`/`finally` statement completes instead, which is only ever
      // reached when the `try` block did NOT already throw.
      if (cleanupIssues.length > 0 && result !== undefined) {
        cleanupError = new AppException(
          AppErrorCode.HLS_CLEANUP_VERIFICATION_FAILED,
          `HLS smoke run succeeded but cleanup could not be proven for ${cleanupIssues.length} object(s)`,
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
    }

    if (cleanupError) {
      throw cleanupError;
    }

    return result;
  }

  private async uploadAndVerify(
    packageRoot: string,
    keyPrefix: string,
    artifacts: HlsRungArtifact[],
    uploadedObjects: HlsUploadedObject[],
  ): Promise<boolean> {
    await this.uploadFile(
      join(packageRoot, HLS_MASTER_PLAYLIST_FILENAME),
      `${keyPrefix}${HLS_MASTER_PLAYLIST_FILENAME}`,
      HLS_PLAYLIST_CONTENT_TYPE,
      uploadedObjects,
    );

    for (const artifact of artifacts) {
      await this.uploadFile(
        join(packageRoot, artifact.playlistRelativePath),
        `${keyPrefix}${artifact.rung.name}/${HLS_VARIANT_PLAYLIST_FILENAME}`,
        HLS_PLAYLIST_CONTENT_TYPE,
        uploadedObjects,
      );

      const entries = await readdir(artifact.outputDir);
      for (const entry of entries) {
        if (entry === HLS_VARIANT_PLAYLIST_FILENAME) {
          continue;
        }

        const contentType = entry.endsWith('.m4s')
          ? HLS_MEDIA_SEGMENT_CONTENT_TYPE
          : HLS_INIT_SEGMENT_CONTENT_TYPE;

        await this.uploadFile(
          join(artifact.outputDir, entry),
          `${keyPrefix}${artifact.rung.name}/${entry}`,
          contentType,
          uploadedObjects,
        );
      }
    }

    for (const object of uploadedObjects) {
      const head = await this.storageService.headObject(object.key);

      if (
        head === null ||
        head.contentLength !== object.sizeBytes ||
        head.contentType !== object.contentType
      ) {
        throw new AppException(
          AppErrorCode.HLS_UPLOAD_VERIFICATION_FAILED,
          `Uploaded object verification failed for key "${object.key}"`,
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
    }

    return true;
  }

  private async uploadFile(
    localPath: string,
    key: string,
    contentType: string,
    uploadedObjects: HlsUploadedObject[],
  ): Promise<void> {
    const body = await readFile(localPath);
    await this.storageService.putObject(key, body, contentType);
    uploadedObjects.push({ key, contentType, sizeBytes: body.byteLength });
  }

  /**
   * Cleanup uses ONLY the in-memory `uploadedObjects` list this run itself
   * built up — never a broad/prefix delete (no `listObjectsByPrefix` exists
   * on `StorageService`, and this design deliberately does not add one: a
   * bounded "track every uploaded key, then HEAD-not-found each after
   * delete" approach is simpler, needs no new storage surface, and is
   * exactly as strong a cleanup proof for a run that controls every key it
   * ever wrote).
   */
  private async cleanupUploadedObjects(
    uploadedObjects: HlsUploadedObject[],
  ): Promise<string[]> {
    const issues: string[] = [];

    for (const object of uploadedObjects) {
      try {
        await this.storageService.deleteObject(object.key);
        const head = await this.storageService.headObject(object.key);

        if (head !== null) {
          issues.push(
            `Object still resolved via HEAD after DeleteObject for key "${object.key}"`,
          );
        }
      } catch (error) {
        issues.push(
          `Delete/verify failed for key "${object.key}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return issues;
  }
}

async function measureDirectory(
  root: string,
): Promise<{ totalLocalBytes: number; totalLocalFileCount: number }> {
  let totalLocalBytes = 0;
  let totalLocalFileCount = 0;

  const entries = await readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(root, entry.name);

    if (entry.isDirectory()) {
      const nested = await measureDirectory(fullPath);
      totalLocalBytes += nested.totalLocalBytes;
      totalLocalFileCount += nested.totalLocalFileCount;
    } else {
      const stats = await stat(fullPath);
      totalLocalBytes += stats.size;
      totalLocalFileCount += 1;
    }
  }

  return { totalLocalBytes, totalLocalFileCount };
}
