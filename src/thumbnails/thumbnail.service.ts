import type { Stats } from 'fs';
import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, extname, join } from 'path';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { redactSensitiveText } from '../common/logging/redact';
import { StorageService } from '../storage/storage.service';
import {
  DEFAULT_THUMBNAIL_TIMESTAMP_SECONDS,
  DEFAULT_THUMBNAIL_WIDTH,
  SUPPORTED_VIDEO_EXTENSIONS,
  THUMBNAIL_CONTENT_TYPE,
  THUMBNAIL_TEMP_DIR_PREFIX,
} from './thumbnail.constants';
import { buildThumbnailStorageKey } from './thumbnail-storage-key.util';
import { THUMBNAIL_CLIENT } from './thumbnail.types';
import type {
  GenerateThumbnailOptions,
  ThumbnailClient,
  ThumbnailIngestResult,
} from './thumbnail.types';

const TEMP_OUTPUT_FILENAME = 'thumbnail.jpg';

/**
 * Phase 11, work unit 11D-2b: generates a single thumbnail frame from a
 * source video (via the injected `ThumbnailClient`) and ingests it into
 * object storage (via `StorageService.putObject`).
 *
 * - Generation always happens inside a fresh `fs.mkdtemp` directory under
 *   `os.tmpdir()`; `options.inputPath` is only ever read, never written to,
 *   moved, or deleted — this must never touch `STORAGE_ROOT` originals (see
 *   AGENT_RULES.md's hard prohibition on modifying company video files).
 * - The temp directory is removed in a `finally` block regardless of
 *   outcome, so a failure never leaves a stray temp file behind, and a
 *   success cleans up its own local copy immediately after ingest.
 * - `StorageService` is injected and, in every test in this file, mocked —
 *   no real R2/network call is ever made from this service. The real
 *   upload target stays gated behind 11D-2-real.
 * - Error messages surfaced via `AppException` deliberately never embed a
 *   raw filesystem path or the underlying error's raw message (which could
 *   contain one) — full detail is logged server-side through the existing
 *   `redactSensitiveText` layer instead (see `../common/logging/redact.ts`).
 */
@Injectable()
export class ThumbnailService {
  private readonly logger = new Logger(ThumbnailService.name);

  constructor(
    @Inject(THUMBNAIL_CLIENT)
    private readonly thumbnailClient: ThumbnailClient,
    private readonly storageService: StorageService,
  ) {}

  async generate(
    options: GenerateThumbnailOptions,
  ): Promise<ThumbnailIngestResult> {
    await this.assertInputExists(options.inputPath);
    this.assertSupportedFormat(options.inputPath);

    const width = options.width ?? DEFAULT_THUMBNAIL_WIDTH;
    const timestampSeconds =
      options.timestampSeconds ?? DEFAULT_THUMBNAIL_TIMESTAMP_SECONDS;
    this.assertValidTimestamp(timestampSeconds);

    const tempDir = await mkdtemp(join(tmpdir(), THUMBNAIL_TEMP_DIR_PREFIX));

    try {
      const outputPath = join(tempDir, TEMP_OUTPUT_FILENAME);

      const artifact = await this.thumbnailClient.generate({
        inputPath: options.inputPath,
        outputPath,
        timestampSeconds,
        width,
      });

      this.assertExpectedDimensions(artifact.width, artifact.height, width);

      const body = await readFile(artifact.outputPath);
      const key = buildThumbnailStorageKey(options.assetId, `w${width}`);

      await this.storageService.putObject(key, body, THUMBNAIL_CONTENT_TYPE);

      return {
        key,
        width: artifact.width,
        height: artifact.height,
        contentType: THUMBNAIL_CONTENT_TYPE,
      };
    } catch (error) {
      throw this.toAppException(error, options.assetId);
    } finally {
      // Cleanup runs on every path — success (the local copy is no longer
      // needed once ingested) and failure (no partial temp output/dir is
      // ever left behind).
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async assertInputExists(inputPath: string): Promise<void> {
    let stats: Stats;
    try {
      stats = await stat(inputPath);
    } catch {
      throw new AppException(
        AppErrorCode.MEDIA_FILE_NOT_FOUND,
        `Thumbnail source video not found: "${basename(inputPath)}"`,
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!stats.isFile()) {
      throw new AppException(
        AppErrorCode.MEDIA_FILE_NOT_FOUND,
        `Thumbnail source is not a file: "${basename(inputPath)}"`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private assertSupportedFormat(inputPath: string): void {
    const extension = extname(inputPath).toLowerCase();

    if (!SUPPORTED_VIDEO_EXTENSIONS.includes(extension)) {
      throw new AppException(
        AppErrorCode.UNSUPPORTED_MEDIA_FORMAT,
        `Unsupported video format "${extension || '(none)'}" — expected one of: ${SUPPORTED_VIDEO_EXTENSIONS.join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private assertValidTimestamp(timestampSeconds: number): void {
    if (!Number.isFinite(timestampSeconds) || timestampSeconds < 0) {
      throw new AppException(
        AppErrorCode.INVALID_THUMBNAIL_TIMESTAMP,
        `Thumbnail timestamp must be a non-negative number of seconds, got ${timestampSeconds}`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private assertExpectedDimensions(
    actualWidth: number,
    actualHeight: number,
    requestedWidth: number,
  ): void {
    if (
      !Number.isFinite(actualWidth) ||
      actualWidth <= 0 ||
      !Number.isFinite(actualHeight) ||
      actualHeight <= 0
    ) {
      throw new AppException(
        AppErrorCode.THUMBNAIL_DIMENSION_MISMATCH,
        `Generated thumbnail has invalid dimensions (${actualWidth}x${actualHeight})`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    if (actualWidth !== requestedWidth) {
      throw new AppException(
        AppErrorCode.THUMBNAIL_DIMENSION_MISMATCH,
        `Generated thumbnail width ${actualWidth}px does not match requested width ${requestedWidth}px`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }

  private toAppException(error: unknown, assetId: string): AppException {
    if (error instanceof AppException) {
      return error;
    }

    const detail =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    this.logger.warn(
      redactSensitiveText(
        `Thumbnail generation failed for asset "${assetId}": ${detail}`,
      ),
    );

    return new AppException(
      AppErrorCode.THUMBNAIL_GENERATION_FAILED,
      'Thumbnail generation failed',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
