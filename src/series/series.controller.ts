import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../admin/guards/admin.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateSeriesDto } from './dto/create-series.dto';
import { UpdateSeriesDto } from './dto/update-series.dto';
import { SeriesDto } from './series.types';
import { SeriesService } from './series.service';

/**
 * Phase 11, work unit 11E-4: the admin-guarded `Series` metadata CRUD
 * (no delete — out of scope). Every route requires both a valid access
 * token (`JwtAuthGuard`) and the `admin` role (`AdminGuard`) —
 * `JwtAuthGuard` MUST be listed first so `AdminGuard` can read
 * `request.user`, mirroring `AdminMediaController`'s existing guard order.
 * Purely additive/metadata-only: no route here reads or writes any `Video`
 * row, and the public `/videos/feed` grouping is unaffected.
 */
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/series')
export class SeriesController {
  constructor(private readonly seriesService: SeriesService) {}

  @Get()
  list(): Promise<SeriesDto[]> {
    return this.seriesService.list();
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
}
