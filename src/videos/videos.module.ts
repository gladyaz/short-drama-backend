import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { StorageModule } from '../storage/storage.module';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

/**
 * Phase 10, work unit 10-B3: imports `AuthModule` (for `JwtAuthGuard`,
 * now applied to the stream route) and `EntitlementsModule` (for the
 * premium-episode access check), matching the existing
 * `InteractionsModule`/`ProgressModule` pattern of importing `AuthModule`
 * for guard access.
 *
 * Phase 11, work unit 11M-B3: also imports `StorageModule` for
 * `StorageService` — `VideosService.getPlaybackUrl` reuses its existing
 * `createPresignedGetUrl`, matching `MediaModule`'s existing pattern of
 * importing `StorageModule` directly rather than relying on a transitive
 * re-export.
 */
@Module({
  imports: [AuthModule, EntitlementsModule, StorageModule],
  controllers: [VideosController],
  providers: [VideosService],
})
export class VideosModule {}
