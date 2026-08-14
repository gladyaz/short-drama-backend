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
import { Throttle } from '@nestjs/throttler';
import { AdminGuard } from '../admin/guards/admin.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  ADMIN_MEDIA_UPLOAD_INITIATE_RATE_LIMIT,
  ADMIN_MEDIA_UPLOAD_INITIATE_RATE_TTL_MS,
} from '../common/rate-limit.constants';
import { CompleteSeriesCoverUploadDto } from './dto/complete-series-cover-upload.dto';
import { CreateSeriesCoverUploadDto } from './dto/create-series-cover-upload.dto';
import { CreateSeriesDto } from './dto/create-series.dto';
import { ListAdminSeriesQueryDto } from './dto/list-admin-series-query.dto';
import { UpdateSeriesDto } from './dto/update-series.dto';
import {
  CreateSeriesCoverUploadResponseDto,
  SeriesDto,
  SeriesWithCoverDto,
} from './series.types';
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
  list(@Query() query: ListAdminSeriesQueryDto): Promise<SeriesWithCoverDto[]> {
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
  findById(@Param('id') id: string): Promise<SeriesWithCoverDto> {
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
   * Work unit "SERIES COVER UPLOAD BACKEND CONTRACT" (approved 2026-08-14):
   * presign-init for a cover-image upload. Mirrors
   * `AdminMediaController`'s dedicated, tighter-than-default throttle on
   * its own presigned-PUT-minting route (`ADMIN_MEDIA_UPLOAD_INITIATE_RATE_
   * LIMIT`, 60/minute) — same rationale here: each call mints a real,
   * credential-backed presigned R2 `PUT` URL, so this must not inherit the
   * generous app-wide default throttle.
   */
  @Post(':id/cover')
  @Throttle({
    default: {
      limit: ADMIN_MEDIA_UPLOAD_INITIATE_RATE_LIMIT,
      ttl: ADMIN_MEDIA_UPLOAD_INITIATE_RATE_TTL_MS,
    },
  })
  createCoverUpload(
    @Param('id') id: string,
    @Body() body: CreateSeriesCoverUploadDto,
  ): Promise<CreateSeriesCoverUploadResponseDto> {
    return this.seriesService.createCoverUpload(id, body);
  }

  /**
   * Work unit "SERIES COVER UPLOAD BACKEND CONTRACT": verifies the upload
   * and, only on success, persists `Series.coverImageKey` (see
   * `SeriesService.completeCoverUpload`'s doc comment for the full
   * verification order). No dedicated throttle override — unlike the
   * presign-init route above, this does not mint a new credential-backed
   * URL; it relies on the app-wide default throttler, matching
   * `AdminMediaController.completeUpload`'s existing precedent (also
   * un-throttled beyond the default).
   */
  @HttpCode(HttpStatus.OK)
  @Post(':id/cover/complete')
  completeCoverUpload(
    @Param('id') id: string,
    @Body() body: CompleteSeriesCoverUploadDto,
  ): Promise<SeriesWithCoverDto> {
    return this.seriesService.completeCoverUpload(id, body);
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
