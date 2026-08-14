import { Controller, Get, Param } from '@nestjs/common';
import { PublicSeriesService } from './series-public.service';
import {
  SeriesDetailPublicDto,
  SeriesListResponseDto,
} from './series-public.types';

/**
 * Work unit "SERIES METADATA + DISCOVER ARTWORK CONTRACT": the public
 * catalog surface for curated series metadata — `GET /series` and
 * `GET /series/:id`. Deliberately a SEPARATE controller from
 * `SeriesController` (`./series.controller.ts`, `@Controller('admin/series')`,
 * `@UseGuards(JwtAuthGuard, AdminGuard)` at the class level): a guard
 * decorator on a controller class applies to every route declared on it,
 * so a public, unauthenticated route can never live on that class without
 * either an easy-to-miss per-route guard override or accidentally
 * inheriting the admin gate. No `@UseGuards` here at all, matching
 * `VideosController`'s existing `GET /videos/feed`/`GET /videos/:id`
 * precedent (public, unauthenticated metadata reads — only the
 * byte-streaming/playback-URL routes on that controller require a token).
 */
@Controller('series')
export class SeriesPublicController {
  constructor(private readonly publicSeriesService: PublicSeriesService) {}

  @Get()
  list(): Promise<SeriesListResponseDto> {
    return this.publicSeriesService.list();
  }

  @Get(':id')
  findById(@Param('id') id: string): Promise<SeriesDetailPublicDto> {
    return this.publicSeriesService.findById(id);
  }
}
