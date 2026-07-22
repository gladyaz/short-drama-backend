import { Controller, Get, HttpStatus, Param, Req, Res } from '@nestjs/common';
import { createReadStream } from 'fs';
import type { Request, Response } from 'express';
import { VideosService } from './videos.service';
import type { VideoResponseDto } from './video.types';
import { parseRangeHeader } from './video-range.util';

@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Get('feed')
  getFeed(): Promise<VideoResponseDto[]> {
    return this.videosService.findAll();
  }

  @Get(':id/stream')
  async streamVideo(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
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
