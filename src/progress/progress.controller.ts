import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UpsertProgressDto } from './dto/upsert-progress.dto';
import { ProgressResponseDto } from './progress.types';
import { ProgressService } from './progress.service';

/**
 * Phase 9, work unit 9-B2. Routes span two unrelated base paths
 * (`/series/:id/progress` and `/users/me/progress`) per the frozen contract,
 * so this controller intentionally has no shared `@Controller()` prefix.
 */
@Controller()
export class ProgressController {
  constructor(private readonly progressService: ProgressService) {}

  @UseGuards(JwtAuthGuard)
  @Put('series/:id/progress')
  upsertProgress(
    @Param('id') seriesId: string,
    @Body() dto: UpsertProgressDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ProgressResponseDto> {
    return this.progressService.upsertProgress(user.id, seriesId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('users/me/progress')
  listMine(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ProgressResponseDto[]> {
    return this.progressService.listForUser(user.id);
  }
}
