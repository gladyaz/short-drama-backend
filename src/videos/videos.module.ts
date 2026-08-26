import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { RewardsModule } from '../rewards/rewards.module';
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
 *
 * Work unit "REWARDS V1 EARN AND SPEND": also imports `RewardsModule` for
 * `RewardsWatchService`, which `GET /videos/:id/playback` calls to record the
 * one watch signal this backend can vouch for. The direction is videos ->
 * rewards and never the reverse — `RewardsModule` imports nothing from here,
 * so there is no cycle — and the videos code owns no reward table of its own:
 * it reports an authorisation, and the rewards domain decides what that is
 * worth.
 */
@Module({
  imports: [AuthModule, EntitlementsModule, StorageModule, RewardsModule],
  controllers: [VideosController],
  providers: [VideosService],
})
export class VideosModule {}
