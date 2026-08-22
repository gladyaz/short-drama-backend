import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { RewardsController } from './rewards.controller';
import { RewardsService } from './rewards.service';
import { RewardsWalletService } from './rewards-wallet.service';
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
 */
@Module({
  imports: [AuthModule, EntitlementsModule],
  controllers: [RewardsController],
  providers: [RewardsService, RewardsWalletService, RewardsEnabledGuard],
  exports: [RewardsService, RewardsWalletService],
})
export class RewardsModule {}
