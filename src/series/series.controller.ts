import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../admin/guards/admin.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateSeriesDto } from './dto/create-series.dto';
import { ListAdminSeriesQueryDto } from './dto/list-admin-series-query.dto';
import { UpdateSeriesDto } from './dto/update-series.dto';
import { SeriesDto } from './series.types';
import { SeriesService } from './series.service';

/**
 * Phase 11, work unit 11E-4 (extended in 11F-1 with read-detail, safe
 * archive/unarchive, and a guarded hard delete): the admin-guarded `Series`
 * metadata surface. Every route requires both a valid access token
 * (`JwtAuthGuard`) and the `admin` role (`AdminGuard`) — `JwtAuthGuard` MUST
 * be listed first so `AdminGuard` can read `request.user`, mirroring
 * `AdminMediaController`'s existing guard order. Purely additive/
 * metadata-only: no route here reads or writes any `Video` row except the
 * read-only published-episode count `DELETE :id` performs to decide whether
 * a hard delete is safe (see `SeriesService.remove`'s doc) — the public
 * `/videos/feed` grouping and every `Video` row are otherwise unaffected.
 */
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/series')
export class SeriesController {
  constructor(private readonly seriesService: SeriesService) {}

  @Get()
  list(@Query() query: ListAdminSeriesQueryDto): Promise<SeriesDto[]> {
    return this.seriesService.list(query);
  }

  /**
   * Work unit 11F-1: read-detail. Declared as `@Get(':id')`, AFTER the bare
   * `@Get()` collection route above — matches only the exact `/admin/series`
   * collection path or a one-segment `:id` path respectively (Nest/Express
   * route matching is path-shape based, not declaration-order based, for
   * these two), mirroring `AdminMediaController`'s existing
   * `@Get()`/`@Get(':id')` precedent.
   */
  @Get(':id')
  findById(@Param('id') id: string): Promise<SeriesDto> {
    return this.seriesService.findById(id);
  }

  @Post()
  create(@Body() body: CreateSeriesDto): Promise<SeriesDto> {
    return this.seriesService.create(body);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: UpdateSeriesDto,
  ): Promise<SeriesDto> {
    return this.seriesService.update(id, body);
  }

  /**
   * Work unit 11F-1: safe (soft) archive — the PRIMARY "delete" action.
   * Idempotent (see `SeriesService.archive`'s doc), so this always returns
   * `200 OK` with the current (now-archived) `SeriesDto`, never a
   * "nothing happened" distinct status.
   */
  @HttpCode(HttpStatus.OK)
  @Post(':id/archive')
  archive(@Param('id') id: string): Promise<SeriesDto> {
    return this.seriesService.archive(id);
  }

  /** Work unit 11F-1: reverses `archive`. Idempotent, same shape as `archive`. */
  @HttpCode(HttpStatus.OK)
  @Post(':id/unarchive')
  unarchive(@Param('id') id: string): Promise<SeriesDto> {
    return this.seriesService.unarchive(id);
  }

  /**
   * Work unit 11F-1: the guarded HARD delete. Refused with `409
   * SERIES_HAS_PUBLISHED_EPISODES` when the series still has at least one
   * `published` episode (see `SeriesService.remove`'s doc) — nothing is
   * written in that case. On success there is no remaining resource to
   * return, so this responds `204 No Content` with an empty body, the
   * standard REST convention for a successful delete.
   */
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  async remove(@Param('id') id: string): Promise<void> {
    await this.seriesService.remove(id);
  }
}
