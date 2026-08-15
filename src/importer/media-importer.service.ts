import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  isValidVideoCategory,
  VIDEO_CATEGORIES,
} from '../videos/video-category.constants';
import { FFPROBE_CLIENT } from './importer.types';
import type {
  FfprobeClient,
  ImportBatchOptions,
  ImportBatchResult,
  ImportItemResult,
  ImportManifestItem,
} from './importer.types';

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Phase 11, work unit 11D-1: bulk-imports/refreshes `Video` catalog rows
 * from a manifest, deriving `durationSeconds`/`width`/`height` via the
 * injected `FfprobeClient` instead of requiring them to be hand-entered
 * (as `prisma/seed.ts`'s hardcoded `VIDEOS` array currently does).
 *
 * - **Idempotent**: `Video.upsert` keyed on `item.id`, mirroring
 *   `prisma/seed.ts`'s existing precedent exactly — re-running the same
 *   manifest updates rows in place rather than duplicating them.
 * - **Deterministic `sortOrder`**: derived from the manifest array's
 *   position (`items[index]` -> `sortOrder: index`), the same convention
 *   `prisma/seed.ts` uses for `VIDEOS`, not from probe timing (items are
 *   probed and written sequentially, not concurrently, so ordering can
 *   never race).
 * - **Retry/failure reporting**: each item gets up to `maxAttempts`
 *   ffprobe attempts (default 3) before being reported as `failed` — a
 *   failure never aborts the batch or writes a partial/garbage row for
 *   that item; every other item is still attempted.
 */
@Injectable()
export class MediaImporterService {
  private readonly logger = new Logger(MediaImporterService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FFPROBE_CLIENT) private readonly ffprobeClient: FfprobeClient,
  ) {}

  async importBatch(
    items: ImportManifestItem[],
    options?: ImportBatchOptions,
  ): Promise<ImportBatchResult> {
    const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const results: ImportItemResult[] = [];

    for (const [index, item] of items.entries()) {
      results.push(await this.importItem(item, index, maxAttempts));
    }

    return {
      results,
      succeeded: results.filter((result) => result.status !== 'failed').length,
      failed: results.filter((result) => result.status === 'failed').length,
    };
  }

  private async importItem(
    item: ImportManifestItem,
    sortOrder: number,
    maxAttempts: number,
  ): Promise<ImportItemResult> {
    // Work unit "Episode Access-Tier + Category Contract Hardening": this
    // importer writes `item.category` straight to `Video.category` with no
    // DTO/`class-validator` layer in front of it (unlike the admin HTTP
    // routes) — checked here, BEFORE any ffprobe attempt or DB read/write,
    // so an unrecognised category never reaches `prisma.video.upsert` and is
    // never retried (a bad category is not a transient failure, unlike an
    // ffprobe hiccup).
    if (!isValidVideoCategory(item.category)) {
      const error = `Unrecognised category ${JSON.stringify(item.category)} — must be one of: ${VIDEO_CATEGORIES.join(', ')}`;
      this.logger.warn(`Rejected media "${item.id}": ${error}`);
      return { id: item.id, status: 'failed', attempts: 0, error };
    }

    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const metadata = await this.ffprobeClient.probe(item.storageKey);
        const existed =
          (await this.prisma.video.findUnique({
            where: { id: item.id },
            select: { id: true },
          })) !== null;

        await this.prisma.video.upsert({
          where: { id: item.id },
          create: {
            id: item.id,
            seriesId: item.seriesId,
            title: item.title,
            episodeNumber: item.episodeNumber,
            channelName: item.channelName,
            caption: item.caption,
            category: item.category,
            storageKey: item.storageKey,
            sourceLanguage: item.sourceLanguage,
            hasEmbeddedIndonesianSubtitle: item.hasEmbeddedIndonesianSubtitle,
            likeCount: 0,
            durationSeconds: metadata.durationSeconds,
            width: metadata.width,
            height: metadata.height,
            sortOrder,
          },
          // `likeCount` is deliberately absent here — it is user-driven
          // (via the interactions endpoints), never reset by a re-import.
          update: {
            seriesId: item.seriesId,
            title: item.title,
            episodeNumber: item.episodeNumber,
            channelName: item.channelName,
            caption: item.caption,
            category: item.category,
            storageKey: item.storageKey,
            sourceLanguage: item.sourceLanguage,
            hasEmbeddedIndonesianSubtitle: item.hasEmbeddedIndonesianSubtitle,
            durationSeconds: metadata.durationSeconds,
            width: metadata.width,
            height: metadata.height,
            sortOrder,
          },
        });

        return {
          id: item.id,
          status: existed ? 'updated' : 'created',
          metadata,
        };
      } catch (error) {
        lastError = error;
        this.logger.warn(
          `ffprobe attempt ${attempt}/${maxAttempts} failed for media "${item.id}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return {
      id: item.id,
      status: 'failed',
      attempts: maxAttempts,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    };
  }
}
