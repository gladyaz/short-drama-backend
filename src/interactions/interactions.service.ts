import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import {
  LikeResponseDto,
  SaveResponseDto,
  UserInteractionDto,
} from './interaction.types';

/**
 * Phase 9, work unit 9-B2: Like/Save synchronization against
 * `UserVideoInteraction` (schema added in 9-B1). `Video.likeCount` becomes a
 * real mutable counter here, per the frozen contract in `DECISIONS.md`.
 *
 * `UserVideoInteraction.videoId`/`WatchProgress.lastWatchedVideoId` are
 * deliberately plain strings with no DB-level FK to `Video` (see the schema
 * comment in `prisma/schema.prisma`), so every write path here explicitly
 * looks up the `Video` row first and throws the same `VIDEO_NOT_FOUND`
 * `AppException` that `VideosService.findRecordById` uses, before touching
 * any interaction/progress row — this is required, not optional, per 9-B1's
 * review note.
 */
@Injectable()
export class InteractionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Sets `isLiked: true` and increments `Video.likeCount` by exactly one,
   * even under concurrent/duplicate calls. Idempotent: liking an
   * already-liked video does not double-increment the counter — the
   * existing `isLiked` value is checked first, and the counter mutation
   * only happens on an actual false->true transition. The interaction
   * upsert and the counter increment happen inside a single
   * `$transaction` so the two tables never diverge if one write succeeds
   * and the other fails.
   */
  async like(userId: string, videoId: string): Promise<LikeResponseDto> {
    await this.assertVideoExists(videoId);

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.userVideoInteraction.findUnique({
        where: { userId_videoId: { userId, videoId } },
      });

      if (existing?.isLiked) {
        const video = await tx.video.findUniqueOrThrow({
          where: { id: videoId },
        });
        return { videoId, isLiked: true, likeCount: video.likeCount };
      }

      await tx.userVideoInteraction.upsert({
        where: { userId_videoId: { userId, videoId } },
        create: { userId, videoId, isLiked: true },
        update: { isLiked: true },
      });

      const video = await tx.video.update({
        where: { id: videoId },
        data: { likeCount: { increment: 1 } },
      });

      return { videoId, isLiked: true, likeCount: video.likeCount };
    });
  }

  /**
   * Sets `isLiked: false` and decrements `Video.likeCount`, floored at 0
   * (never negative). Idempotent the same way as `like`: unliking a video
   * that isn't currently liked by this user (no row, or `isLiked: false`
   * already) leaves the counter untouched.
   */
  async unlike(userId: string, videoId: string): Promise<LikeResponseDto> {
    await this.assertVideoExists(videoId);

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.userVideoInteraction.findUnique({
        where: { userId_videoId: { userId, videoId } },
      });

      if (!existing?.isLiked) {
        const video = await tx.video.findUniqueOrThrow({
          where: { id: videoId },
        });
        return { videoId, isLiked: false, likeCount: video.likeCount };
      }

      await tx.userVideoInteraction.update({
        where: { userId_videoId: { userId, videoId } },
        data: { isLiked: false },
      });

      const current = await tx.video.findUniqueOrThrow({
        where: { id: videoId },
      });
      const flooredLikeCount = Math.max(0, current.likeCount - 1);

      const video = await tx.video.update({
        where: { id: videoId },
        data: { likeCount: flooredLikeCount },
      });

      return { videoId, isLiked: false, likeCount: video.likeCount };
    });
  }

  async save(userId: string, videoId: string): Promise<SaveResponseDto> {
    await this.assertVideoExists(videoId);

    await this.prisma.userVideoInteraction.upsert({
      where: { userId_videoId: { userId, videoId } },
      create: { userId, videoId, isSaved: true },
      update: { isSaved: true },
    });

    return { videoId, isSaved: true };
  }

  async unsave(userId: string, videoId: string): Promise<SaveResponseDto> {
    await this.assertVideoExists(videoId);

    await this.prisma.userVideoInteraction.upsert({
      where: { userId_videoId: { userId, videoId } },
      create: { userId, videoId, isSaved: false },
      update: { isSaved: false },
    });

    return { videoId, isSaved: false };
  }

  async listForUser(userId: string): Promise<UserInteractionDto[]> {
    const rows = await this.prisma.userVideoInteraction.findMany({
      where: { userId },
    });

    return rows.map((row) => ({
      videoId: row.videoId,
      isLiked: row.isLiked,
      isSaved: row.isSaved,
    }));
  }

  /**
   * `UserVideoInteraction.videoId` has no DB-level FK to `Video.id` (see the
   * schema comment), so every write path must explicitly verify the video
   * exists first, matching `VideosService.findRecordById`'s `VIDEO_NOT_FOUND`
   * convention, so a nonexistent `videoId` never silently creates an
   * orphaned interaction row.
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
}
