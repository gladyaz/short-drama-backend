import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import {
  ExportedEntitlementDto,
  ExportedInteractionDto,
  ExportedWatchProgressDto,
  UserExportDto,
} from './export.types';

/**
 * Phase 12, work unit 12C-B2: assembles the caller's own personal-data
 * export (`GET /users/me/export`). See `export.types.ts` for the full
 * include/exclude/transform reasoning, model by model, and the frozen
 * contract this implements (`DECISIONS.md` "Phase 12 ... approved..." entry,
 * decision 5).
 *
 * Every Prisma query below uses an explicit `select` (never the bare model)
 * so fields this work unit must exclude — surrogate ids, `Video.storageKey`/
 * `objectStorageKey`, etc. — are never even fetched into memory, not merely
 * omitted from the response after the fact.
 */
@Injectable()
export class ExportService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `JwtAuthGuard` verifies the access token's signature/expiry without a
   * database hit (by design — see that guard's doc comment), so a token
   * issued to an account that has since been deleted (e.g. via `POST
   * /users/me/deletion`) still passes the guard until it naturally expires
   * (~15 min). Every `@CurrentUser()` consumer that actually needs to read
   * `User` columns must therefore re-check existence itself, exactly like
   * `AuthService.getUserById` (`GET /auth/me`) and
   * `AuthService.deleteAccount` already do — reusing the SAME generic
   * `INVALID_ACCESS_TOKEN`/401 error those two use for the identical
   * condition, rather than inventing a distinct "user not found" response
   * that would tell a caller something they have no legitimate need to know.
   */
  async exportForUser(userId: string): Promise<UserExportDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, displayName: true, createdAt: true },
    });

    if (!user) {
      throw new AppException(
        AppErrorCode.INVALID_ACCESS_TOKEN,
        'Invalid or expired access token',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const [interactionRows, progressRows, entitlementRows] = await Promise.all([
      this.prisma.userVideoInteraction.findMany({
        where: { userId },
        select: {
          videoId: true,
          isLiked: true,
          isSaved: true,
          updatedAt: true,
        },
      }),
      this.prisma.watchProgress.findMany({
        where: { userId },
        select: {
          seriesId: true,
          lastWatchedVideoId: true,
          lastWatchedEpisodeNumber: true,
          positionSeconds: true,
          durationSeconds: true,
          updatedAt: true,
        },
      }),
      this.prisma.entitlement.findMany({
        where: { userId },
        select: {
          tier: true,
          source: true,
          grantedAt: true,
          expiresAt: true,
          revokedAt: true,
        },
        orderBy: { grantedAt: 'desc' },
      }),
    ]);

    const titleByVideoId = await this.loadVideoTitles([
      ...interactionRows.map((row) => row.videoId),
      ...progressRows.map((row) => row.lastWatchedVideoId),
    ]);

    const interactions: ExportedInteractionDto[] = interactionRows.map(
      (row) => ({
        videoId: row.videoId,
        videoTitle: titleByVideoId.get(row.videoId) ?? null,
        isLiked: row.isLiked,
        isSaved: row.isSaved,
        updatedAt: row.updatedAt.toISOString(),
      }),
    );

    const watchProgress: ExportedWatchProgressDto[] = progressRows.map(
      (row) => ({
        seriesId: row.seriesId,
        videoId: row.lastWatchedVideoId,
        videoTitle: titleByVideoId.get(row.lastWatchedVideoId) ?? null,
        episodeNumber: row.lastWatchedEpisodeNumber,
        positionSeconds: row.positionSeconds,
        durationSeconds: row.durationSeconds ?? undefined,
        updatedAt: row.updatedAt.toISOString(),
      }),
    );

    const entitlements: ExportedEntitlementDto[] = entitlementRows.map(
      (row) => ({
        tier: row.tier,
        source: row.source,
        grantedAt: row.grantedAt.toISOString(),
        expiresAt: row.expiresAt?.toISOString() ?? null,
        revokedAt: row.revokedAt?.toISOString() ?? null,
      }),
    );

    return {
      exportedAt: new Date().toISOString(),
      profile: {
        email: user.email,
        displayName: user.displayName ?? null,
        memberSince: user.createdAt.toISOString(),
      },
      interactions,
      watchProgress,
      entitlements,
    };
  }

  /**
   * Batched title lookup for every distinct catalog `videoId` referenced by
   * this account's interactions/progress rows. Deliberately selects ONLY
   * `id`/`title` — never `storageKey`/`objectStorageKey`/`coverImageKey`/
   * `thumbnailImageKey`/`accessTierOverride`/any other `Video` column — so
   * there is no code path here that could ever surface a storage path/key
   * into this export, regardless of what `Video` gains in the future.
   * `videoId`/`lastWatchedVideoId` have no DB-level FK to `Video` (see
   * `prisma/schema.prisma`), so a referenced id that no longer resolves is a
   * normal, handled case (the caller falls back to `null` in the DTO
   * mapping above), not an error.
   */
  private async loadVideoTitles(
    videoIds: string[],
  ): Promise<Map<string, string>> {
    const uniqueIds = Array.from(new Set(videoIds));

    if (uniqueIds.length === 0) {
      return new Map();
    }

    const rows = await this.prisma.video.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true, title: true },
    });

    return new Map(rows.map((row) => [row.id, row.title]));
  }
}
