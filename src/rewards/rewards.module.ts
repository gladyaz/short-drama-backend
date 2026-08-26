import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { RewardsController } from './rewards.controller';
import { RewardsService } from './rewards.service';
import { RewardsMissionsService } from './rewards-missions.service';
import { RewardsPerksService } from './rewards-perks.service';
import { RewardsWalletService } from './rewards-wallet.service';
import { RewardsWatchService } from './rewards-watch.service';
import { RewardsEnabledGuard } from './guards/rewards-enabled.guard';

/**
 * Work unit "REWARDS BACKEND FOUNDATION".
 *
 * Imports `AuthModule` for `JwtAuthGuard` (the `InteractionsModule`/
 * `ProgressModule`/`EntitlementsModule` precedent) and `EntitlementsModule`
 * for two things: `DevToolsGuard`, which that module already exports for
 * exactly this reuse, and `EntitlementsService`, whose `grantTimedPremium`
 * is how a redemption becomes premium.
 *
 * THE DEPENDENCY DIRECTION IS DELIBERATE: rewards depends on entitlements,
 * never the reverse. Premium remains owned by `EntitlementsService` — the
 * rewards module never writes the `Entitlement` table itself, so there is no
 * second way to become premium and no chance of the two disagreeing. This is
 * the same shape the payments module already uses.
 *
 * `RewardsWalletService` is exported so a future module with a genuinely
 * server-verified earn path (rewarded-ad server callbacks, real watch
 * analytics) can append through the single audited writer instead of growing
 * its own balance-mutation code.
 *
 * Work unit "REWARDS V1 EARN AND SPEND" took that offer up. `VideosModule`
 * now imports this module for `RewardsWatchService`, so the ONE
 * server-observed watch signal this backend has is recorded through the
 * rewards domain rather than by videos code growing reward tables of its own.
 *
 * THE DEPENDENCY DIRECTION STAYS ONE-WAY: videos -> rewards, never the
 * reverse. This module knows nothing about `VideosService`, `Video`, or
 * playback; it accepts an id and a user and records that a thing was
 * authorised. That is what keeps the import from becoming a cycle and what
 * lets the rewards module be reasoned about without reading the media stack.
 */
@Module({
  imports: [AuthModule, EntitlementsModule],
  controllers: [RewardsController],
  providers: [
    RewardsService,
    RewardsWalletService,
    RewardsMissionsService,
    RewardsPerksService,
    RewardsWatchService,
    RewardsEnabledGuard,
  ],
  exports: [
    RewardsService,
    RewardsWalletService,
    RewardsPerksService,
    RewardsWatchService,
  ],
})
export class RewardsModule {}
