import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { AdminMediaController } from './admin-media.controller';
import { AdminMediaService } from './admin-media.service';
import { MediaLifecycleService } from './media-lifecycle.service';

/**
 * Phase 11, work units 11B-1/11B-3: houses the media lifecycle state
 * machine and the admin-guarded `/admin/media` upload/publish API.
 * Imports `AuthModule` for `JwtAuthGuard` and `AdminModule` for
 * `AdminGuard` directly (matching `VideosModule`'s existing pattern of
 * importing every guard-providing module it needs, rather than relying on
 * transitive re-exports), and `StorageModule` for `StorageService`.
 */
@Module({
  imports: [AuthModule, AdminModule, StorageModule],
  controllers: [AdminMediaController],
  providers: [MediaLifecycleService, AdminMediaService],
  exports: [MediaLifecycleService],
})
export class MediaModule {}
