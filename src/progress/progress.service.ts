import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { UpsertProgressDto } from './dto/upsert-progress.dto';
import { ProgressResponseDto } from './progress.types';

/**
 * Phase 9, work unit 9-B2: per-user, per-series watch-progress
 * synchronization against `WatchProgress` (schema added in 9-B1).
 *
 * There is no `Series` table to validate the `:id` series path param
 * against (see the `prisma/schema.prisma` comment on `WatchProgress`), so
 * the only DB-checkable reference here is the body's `videoId` — this
 * service explicitly looks that up in `Video` first (same
 * `VIDEO_NOT_FOUND` `AppException` convention as `VideosService`) before
 * writing any progress row, per 9-B1's review note.
 */
@Injectable()
export class ProgressService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Genuine upsert keyed on the `(userId, seriesId)` unique constraint from
   * 9-B1: creates a new row on first call for a given user+series, updates
   * the existing row on every subsequent call.
   */
  async upsertProgress(
    userId: string,
    seriesId: string,
    dto: UpsertProgressDto,
  ): Promise<ProgressResponseDto> {
    await this.assertVideoExists(dto.videoId);

    const record = await this.prisma.watchProgress.upsert({
      where: { userId_seriesId: { userId, seriesId } },
      create: {
        userId,
        seriesId,
        lastWatchedVideoId: dto.videoId,
        lastWatchedEpisodeNumber: dto.episodeNumber,
        positionSeconds: dto.positionSeconds,
        durationSeconds: dto.durationSeconds,
      },
      update: {
        lastWatchedVideoId: dto.videoId,
        lastWatchedEpisodeNumber: dto.episodeNumber,
        positionSeconds: dto.positionSeconds,
        durationSeconds: dto.durationSeconds,
      },
    });

    return this.toResponseDto(record);
  }

  async listForUser(userId: string): Promise<ProgressResponseDto[]> {
    const records = await this.prisma.watchProgress.findMany({
      where: { userId },
    });

    return records.map((record) => this.toResponseDto(record));
  }

  /**
   * `WatchProgress.lastWatchedVideoId` has no DB-level FK to `Video.id` (see
   * the schema comment), so the body's `videoId` must be explicitly verified
   * to exist before any upsert, so a nonexistent `videoId` never silently
   * creates an orphaned progress row.
   */
  private async assertVideoExists(videoId: string): Promise<void> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
    });

    if (!video) {
      throw new AppException(
        AppErrorCode.VIDEO_NOT_FOUND,
        'Video not found',
        HttpStatus.NOT_FOUND,
      );
    }
  }

  private toResponseDto(record: {
    seriesId: string;
    lastWatchedVideoId: string;
    lastWatchedEpisodeNumber: number;
    positionSeconds: number;
    durationSeconds: number | null;
  }): ProgressResponseDto {
    return {
      seriesId: record.seriesId,
      videoId: record.lastWatchedVideoId,
      episodeNumber: record.lastWatchedEpisodeNumber,
      positionSeconds: record.positionSeconds,
      durationSeconds: record.durationSeconds ?? undefined,
    };
  }
}
