import { Injectable, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, statSync } from 'fs';
import { AppConfig, RootConfig } from '../config/configuration';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { MediaLifecycleState } from '../media/media-lifecycle.types';
import { PrismaService } from '../prisma/prisma.service';
import { VideoRecord, VideoResponseDto } from './video.types';
import { resolveSafeStoragePath } from './storage-path.util';

export interface StreamableVideo {
  record: VideoRecord;
  absolutePath: string;
  fileSize: number;
}

@Injectable()
export class VideosService {
  private readonly appConfig: AppConfig;

  constructor(
    private readonly configService: ConfigService<RootConfig>,
    private readonly prisma: PrismaService,
  ) {
    this.appConfig = this.configService.get('app', { infer: true })!;
  }

  async findAll(): Promise<VideoResponseDto[]> {
    // Explicit, deterministic ordering (work unit 8-B4 fix cycle 1): without
    // an `orderBy`, SQLite happens to satisfy this query via the primary-key
    // index (alphabetical by `id`), which silently changed the feed's
    // starting video after the Prisma migration. `sortOrder` is a dedicated
    // column carrying the original curated order from `videos.data.ts`
    // (series-104 first) — `seriesId`/`episodeNumber` ordering does not
    // reproduce that order, since series are not curated alphabetically.
    //
    // `lifecycleState: PUBLISHED` (Phase 11, work unit 11B-3): the public
    // feed must never leak `draft`/`ready`/`unpublished`/`failed` rows
    // created by the admin media pipeline — those have no guarantee of a
    // real, streamable file yet. Every one of the 40 pre-existing rows
    // already defaults to `"published"` (11A-2's migration), so this is a
    // no-op for them and does not change `findAll`'s existing behavior.
    //
    // The `OR` (Phase 11, work unit 11G-1): closes a residual leak the
    // `lifecycleState` filter above does not cover — a row can be marked
    // `published` (e.g. by a future/partial admin flow) while still having
    // no playable source at all: an empty local `storageKey` (`""`, the
    // fallback used by non-file fixtures — see e.g.
    // `test/videos.e2e-spec.ts`'s `createOverrideFixture`) AND no
    // `objectStorageKey` (the R2/S3 pipeline column added in 11A-2, still
    // unused for real playback — see 11A-3/11B). A row is kept if EITHER
    // source is present; it is excluded only when both are absent. Every one
    // of the 40 pre-existing seed rows has a non-empty `storageKey`, so this
    // is a no-op for them and does not change `findAll`'s existing behavior.
    const records = await this.prisma.video.findMany({
      where: {
        lifecycleState: MediaLifecycleState.PUBLISHED,
        OR: [{ storageKey: { not: '' } }, { objectStorageKey: { not: null } }],
      },
      orderBy: { sortOrder: 'asc' },
    });
    return records.map((record) =>
      this.toResponseDto(this.toVideoRecord(record)),
    );
  }

  async findById(id: string): Promise<VideoResponseDto> {
    return this.toResponseDto(await this.findRecordById(id));
  }

  async resolveStreamableFile(id: string): Promise<StreamableVideo> {
    const record = await this.findRecordById(id);
    const absolutePath = resolveSafeStoragePath(
      this.appConfig.storageRoot,
      record.storageKey,
    );

    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      throw new AppException(
        AppErrorCode.MEDIA_FILE_NOT_FOUND,
        'Media file not found on storage',
        HttpStatus.NOT_FOUND,
      );
    }

    const { size: fileSize } = statSync(absolutePath);
    return { record, absolutePath, fileSize };
  }

  /**
   * Work unit 11E-3: the minimal lookup `VideosController#streamVideo` uses
   * to resolve the premium/free decision for `id`, before any entitlement
   * check or filesystem access. Deliberately returns only `episodeNumber`
   * and `accessTierOverride` — NOT the full `VideoRecord`/`VideoResponseDto`
   * — since `accessTierOverride` must never reach the public API surface
   * (see `AdminMediaDto` in `src/media/media.types.ts` for its only intended
   * external exposure). Applies the same "not published -> VIDEO_NOT_FOUND"
   * rule as `findById`/`resolveStreamableFile` (via the shared
   * `findPublishedRow` helper), so an unpublished/nonexistent id behaves
   * identically at this stage of the stream pipeline too.
   */
  async getStreamGuardInfo(
    id: string,
  ): Promise<{ episodeNumber: number; accessTierOverride: string | null }> {
    const record = await this.findPublishedRow(id);
    return {
      episodeNumber: record.episodeNumber,
      accessTierOverride: record.accessTierOverride,
    };
  }

  private async findRecordById(id: string): Promise<VideoRecord> {
    return this.toVideoRecord(await this.findPublishedRow(id));
  }

  /**
   * Shared by `findRecordById` (and transitively `findById`/
   * `resolveStreamableFile`) and `getStreamGuardInfo`: fetches the raw
   * Prisma row and enforces the existing "must be published" rule. A row
   * that exists but is not `published` (Phase 11, work unit 11B-3: a
   * draft/ready/unpublished/failed row from the admin media pipeline) is
   * treated identically to a nonexistent one — the same `VIDEO_NOT_FOUND`
   * outcome, deliberately not a distinct code, so a caller cannot use this
   * endpoint to enumerate unpublished ids.
   */
  private async findPublishedRow(id: string) {
    const record = await this.prisma.video.findUnique({ where: { id } });

    if (
      !record ||
      record.lifecycleState !== (MediaLifecycleState.PUBLISHED as string)
    ) {
      throw new AppException(
        AppErrorCode.VIDEO_NOT_FOUND,
        'Video not found',
        HttpStatus.NOT_FOUND,
      );
    }

    return record;
  }

  /**
   * Prisma's generated `Video` type represents nullable optional columns as
   * `T | null`, whereas `VideoRecord` (used across the rest of the app,
   * including `videos.data.ts`) represents them as `T | undefined`. This
   * normalizes the DB row into the app-level shape without changing any
   * value that was actually present.
   */
  private toVideoRecord(record: {
    id: string;
    seriesId: string;
    title: string;
    episodeNumber: number;
    channelName: string;
    caption: string;
    category: string;
    storageKey: string;
    sourceLanguage: string;
    hasEmbeddedIndonesianSubtitle: boolean;
    likeCount: number;
    durationSeconds: number | null;
    width: number | null;
    height: number | null;
  }): VideoRecord {
    return {
      ...record,
      durationSeconds: record.durationSeconds ?? undefined,
      width: record.width ?? undefined,
      height: record.height ?? undefined,
    };
  }

  private toResponseDto(record: VideoRecord): VideoResponseDto {
    return {
      id: record.id,
      seriesId: record.seriesId,
      title: record.title,
      episodeNumber: record.episodeNumber,
      channelName: record.channelName,
      caption: record.caption,
      category: record.category,
      storageKey: record.storageKey,
      playbackUrl: `${this.appConfig.publicBaseUrl}/videos/${record.id}/stream`,
      sourceLanguage: record.sourceLanguage,
      hasEmbeddedIndonesianSubtitle: record.hasEmbeddedIndonesianSubtitle,
      likeCount: record.likeCount,
      durationSeconds: record.durationSeconds,
      width: record.width,
      height: record.height,
    };
  }
}
