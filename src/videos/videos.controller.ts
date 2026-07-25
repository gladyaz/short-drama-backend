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
import type { Request, Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { FREE_EPISODE_LIMIT } from '../entitlements/entitlement.constants';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { VideosService } from './videos.service';
import type { VideoResponseDto } from './video.types';
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
   * falls back UNCHANGED to the original `episodeNumber >=
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

  @Get(':id')
  getById(@Param('id') id: string): Promise<VideoResponseDto> {
    return this.videosService.findById(id);
  }
}
