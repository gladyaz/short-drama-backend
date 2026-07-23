import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AnalyticsService } from './analytics.service';
import type { IngestEventsResponseDto } from './analytics.types';
import { IngestEventsDto } from './dto/ingest-events.dto';

/**
 * Phase 11, work units 11-B3. JWT-required by recorded decision
 * (DECISIONS.md "Phase 11 approved...", default decision 3) — guests
 * currently cannot play anything anyway post-Phase 10, and requiring auth
 * sidesteps the anonymous-abuse posture this backend (still without rate
 * limiting, a known gap deferred to Phase 12) is not yet equipped for.
 */
@Controller()
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @UseGuards(JwtAuthGuard)
  @Post('analytics/events')
  ingest(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: IngestEventsDto,
  ): Promise<IngestEventsResponseDto> {
    return this.analyticsService.ingest(user.id, body.events);
  }
}
