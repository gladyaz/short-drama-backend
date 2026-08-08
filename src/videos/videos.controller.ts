import {
  Controller,
  Get,
  HttpStatus,
  Param,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { createReadStream } from 'fs';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import {
  VIDEO_PLAYBACK_URL_RATE_LIMIT,
  VIDEO_PLAYBACK_URL_RATE_TTL_MS,
} from '../common/rate-limit.constants';
import { FREE_EPISODE_LIMIT } from '../entitlements/entitlement.constants';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { VideosService } from './videos.service';
import type { VideoPlaybackResponseDto, VideoResponseDto } from './video.types';
import { parseRangeHeader } from './video-range.util';

@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly entitlementsService: EntitlementsService,
  ) {}

  @Get('feed')
  getFeed(): Promise<VideoResponseDto[]> {
    return this.videosService.findAll();
  }

  /**
   * Phase 10, work unit 10-B3: previously this route had no guard at all —
   * any client with a video id could stream the file directly, bypassing
   * whatever premium gate the mobile UI showed. `JwtAuthGuard` now requires
   * a valid access token for every stream request (see DECISIONS.md "Phase
   * 10 approved..." entry, default decision 1), and the entitlement check
   * below runs before `resolveStreamableFile()` touches the filesystem, so a
   * denied request never opens a file handle for a video it isn't allowed
   * to read.
   *
   * Phase 11, work unit 11E-3: the premium/free decision itself now goes
   * through `EntitlementsService.resolveEpisodePremium`, which honors a
   * per-episode `accessTierOverride` (set via the admin-guarded
   * `PATCH /admin/media/:id/access-tier`) when one is set, and otherwise
   * falls back UNCHANGED to the original `episodeNumber >
   * FREE_EPISODE_LIMIT` rule — every one of the 40 pre-existing rows has no
   * override, so this is behavior-preserving for them.
   */
  @UseGuards(JwtAuthGuard)
  @Get(':id/stream')
  async streamVideo(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.enforceEntitlementGate(id, user);

    const { absolutePath, fileSize } =
      await this.videosService.resolveStreamableFile(id);
    const range = parseRangeHeader(req.headers.range, fileSize);

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'video/mp4');

    const start = range?.start ?? 0;
    const end = range?.end ?? fileSize - 1;
    const stream = createReadStream(absolutePath, { start, end });
    req.on('close', () => stream.destroy());

    if (range) {
      res.status(HttpStatus.PARTIAL_CONTENT);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', end - start + 1);
    } else {
      res.status(HttpStatus.OK);
      res.setHeader('Content-Length', fileSize);
    }

    stream.pipe(res);
  }

  /**
   * Phase 11, work unit 11M-B4 (DECISIONS.md "Slice 11M approved..." entry,
   * Option A). Answers for BOTH storage kinds — R2-backed media gets a
   * short-lived presigned GET URL (`requiresAuthHeader: false`); local-backed
   * media gets its existing `/videos/:id/stream` URL (`requiresAuthHeader:
   * true`, still gated by `JwtAuthGuard` + the entitlement check on every
   * request there) — so the mobile client keeps ONE code path and learns
   * nothing about which backend served a given video.
   *
   * ⚠️ Applies the EXACT SAME `enforceEntitlementGate` call `streamVideo`
   * uses above, not a separate/parallel implementation: without this, a
   * non-entitled user could bypass the premium paywall entirely by asking
   * for a playback URL instead of a stream (see DECISIONS.md's
   * "load-bearing discovery" paragraph — this is the single highest-risk
   * property of this slice).
   *
   * `@Throttle()` override (independent review addendum, 2026-08-08): see
   * `VIDEO_PLAYBACK_URL_RATE_LIMIT`'s doc comment in
   * `common/rate-limit.constants.ts` for why this route does not rely on
   * the generous app-wide default — it mints a directly-shareable,
   * auth-free presigned URL for R2-backed media, the same class of risk
   * `ADMIN_MEDIA_UPLOAD_INITIATE_RATE_LIMIT` already exists to bound for
   * the PUT-minting route.
   */
  @UseGuards(JwtAuthGuard)
  @Throttle({
    default: {
      limit: VIDEO_PLAYBACK_URL_RATE_LIMIT,
      ttl: VIDEO_PLAYBACK_URL_RATE_TTL_MS,
    },
  })
  @Get(':id/playback')
  async getPlaybackUrl(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<VideoPlaybackResponseDto> {
    await this.enforceEntitlementGate(id, user);
    return this.videosService.getPlaybackUrl(id);
  }

  @Get(':id')
  getById(@Param('id') id: string): Promise<VideoResponseDto> {
    return this.videosService.findById(id);
  }

  /**
   * Phase 11, work unit 11M-B2: extracted, behavior-preserving, from what
   * used to be `streamVideo`'s own inline check — now the SINGLE place both
   * `streamVideo` and `getPlaybackUrl` run the "not found" / "not
   * published" / "premium episode, not entitled" gate through, so the two
   * routes can never drift apart on who is allowed to play a given episode.
   * Throws `VIDEO_NOT_FOUND` (via `getStreamGuardInfo`) for a
   * nonexistent/non-published id, or `ENTITLEMENT_REQUIRED` for an
   * authenticated-but-not-entitled caller on a premium episode; returns
   * normally (void) once the caller is allowed to proceed.
   */
  private async enforceEntitlementGate(
    id: string,
    user: AuthenticatedUser,
  ): Promise<void> {
    const guardInfo = await this.videosService.getStreamGuardInfo(id);

    if (
      this.entitlementsService.resolveEpisodePremium(
        guardInfo,
        FREE_EPISODE_LIMIT,
      ) &&
      !(await this.entitlementsService.isEntitled(user.id))
    ) {
      throw new AppException(
        AppErrorCode.ENTITLEMENT_REQUIRED,
        'An active entitlement is required to stream this episode',
        HttpStatus.FORBIDDEN,
      );
    }
  }
}
