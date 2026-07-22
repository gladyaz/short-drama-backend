import { Injectable, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, statSync } from 'fs';
import { AppConfig, RootConfig } from '../config/configuration';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
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
    const records = await this.prisma.video.findMany({
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

  private async findRecordById(id: string): Promise<VideoRecord> {
    const record = await this.prisma.video.findUnique({ where: { id } });
    if (!record) {
      throw new AppException(
        AppErrorCode.VIDEO_NOT_FOUND,
        'Video not found',
        HttpStatus.NOT_FOUND,
      );
    }
    return this.toVideoRecord(record);
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
