import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/**
 * Phase 11, work unit 11-B3. Imports `AuthModule` for `JwtAuthGuard`,
 * matching the `InteractionsModule`/`ProgressModule`/`EntitlementsModule`
 * precedent.
 */
@Module({
  imports: [AuthModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
