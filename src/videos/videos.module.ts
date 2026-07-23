import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

/**
 * Phase 10, work unit 10-B3: imports `AuthModule` (for `JwtAuthGuard`,
 * now applied to the stream route) and `EntitlementsModule` (for the
 * premium-episode access check), matching the existing
 * `InteractionsModule`/`ProgressModule` pattern of importing `AuthModule`
 * for guard access.
 */
@Module({
  imports: [AuthModule, EntitlementsModule],
  controllers: [VideosController],
  providers: [VideosService],
})
export class VideosModule {}
