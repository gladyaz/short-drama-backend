import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  REWARD_CHECK_IN_RATE_LIMIT,
  REWARD_CHECK_IN_RATE_TTL_MS,
  REWARD_REDEEM_RATE_LIMIT,
  REWARD_REDEEM_RATE_TTL_MS,
} from '../common/rate-limit.constants';
import { DevToolsGuard } from '../entitlements/guards/dev-tools.guard';
import { DevGrantPointsDto } from './dto/dev-grant-points.dto';
import { RedeemRewardDto } from './dto/redeem-reward.dto';
import { RewardLedgerQueryDto } from './dto/reward-ledger-query.dto';
import { RewardsEnabledGuard } from './guards/rewards-enabled.guard';
import { RewardsService } from './rewards.service';
import {
  CheckInResponseDto,
  RedeemResponseDto,
  RewardLedgerPageDto,
  RewardsSnapshotDto,
  RewardWalletDto,
} from './rewards.types';

/**
 * Work unit "REWARDS BACKEND FOUNDATION": the `/rewards/*` HTTP surface.
 *
 * EVERY ROUTE IS AUTHENTICATED. Unlike playback — which was deliberately
 * opened to guests for FREE episodes — rewards are account state by
 * definition: there is no wallet without an account to own it, and no
 * meaningful anonymous streak. `JwtAuthGuard` (not `OptionalJwtAuthGuard`)
 * is therefore correct on all of them, and the user id always comes from the
 * verified token via `@CurrentUser()` — never from a path or body parameter,
 * so one account can never act on another's balance.
 *
 * `RewardsEnabledGuard` runs alongside it on every route, so a deployment
 * with the feature dark answers a uniform 503 rather than exposing a partial
 * surface.
 *
 * The `/dev/rewards/*` routes carry the additional `DevToolsGuard`, reusing
 * the guard `EntitlementsModule` already exports rather than duplicating the
 * `DEV_TOOLS_ENABLED` check — the same reuse `AdminModule`'s `/dev/admin/*`
 * routes make.
 */
@Controller()
export class RewardsController {
  constructor(private readonly rewardsService: RewardsService) {}

  /**
   * The whole Rewards Center in one read. Deliberately one call rather than
   * four: the wallet, the streak strip and the redemption availability must
   * agree with each other, and four independent requests can interleave with
   * a check-in and render a balance that disagrees with the strip beside it.
   */
  @UseGuards(JwtAuthGuard, RewardsEnabledGuard)
  @Get('rewards/snapshot')
  getSnapshot(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RewardsSnapshotDto> {
    return this.rewardsService.getSnapshot(user.id);
  }

  /**
   * Claims today's check-in.
   *
   * Takes NO BODY. The date is the server's, the amount is the server's, and
   * the idempotency key is derived from the date — so there is nothing for a
   * client to send and nothing it could send that would change the outcome.
   * That is the "client sends intent, server decides value" rule at its
   * strongest: here the intent is the request itself.
   *
   * 200, not 201: a repeat call creates nothing, and answering 201 to a
   * replay would misreport a no-op as a creation.
   */
  @UseGuards(JwtAuthGuard, RewardsEnabledGuard)
  @Throttle({
    default: {
      limit: REWARD_CHECK_IN_RATE_LIMIT,
      ttl: REWARD_CHECK_IN_RATE_TTL_MS,
    },
  })
  @HttpCode(HttpStatus.OK)
  @Post('rewards/check-in')
  checkIn(@CurrentUser() user: AuthenticatedUser): Promise<CheckInResponseDto> {
    return this.rewardsService.checkIn(user.id);
  }

  /** Paginated, newest-first ledger history for the authenticated caller. */
  @UseGuards(JwtAuthGuard, RewardsEnabledGuard)
  @Get('rewards/ledger')
  getLedger(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: RewardLedgerQueryDto,
  ): Promise<RewardLedgerPageDto> {
    return this.rewardsService.getLedger(user.id, query.limit, query.cursor);
  }

  /**
   * Spends points on a catalog offer, granting premium in the same
   * transaction as the debit.
   *
   * 200, not 201: the response is a receipt whose meaning does not depend on
   * whether this particular call created it — a replayed redemption returns
   * the original receipt with `replayed: true`, and two different statuses
   * for the same body would push clients into branching on the status line
   * instead of reading the flag.
   */
  @UseGuards(JwtAuthGuard, RewardsEnabledGuard)
  @Throttle({
    default: {
      limit: REWARD_REDEEM_RATE_LIMIT,
      ttl: REWARD_REDEEM_RATE_TTL_MS,
    },
  })
  @HttpCode(HttpStatus.OK)
  @Post('rewards/redemptions')
  redeem(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: RedeemRewardDto,
  ): Promise<RedeemResponseDto> {
    return this.rewardsService.redeem(
      user.id,
      body.offerId,
      body.idempotencyKey,
    );
  }

  /**
   * DEV-ONLY: credits points so the local demo can reach a redeemable
   * balance immediately. Still a real, idempotent, reconcilable ledger
   * movement — see `RewardsService.devGrantPoints`.
   */
  @UseGuards(JwtAuthGuard, RewardsEnabledGuard, DevToolsGuard)
  @HttpCode(HttpStatus.OK)
  @Post('dev/rewards/grant')
  devGrant(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: DevGrantPointsDto,
  ): Promise<RewardWalletDto> {
    return this.rewardsService.devGrantPoints(
      body.targetUserId ?? user.id,
      body.points,
      body.idempotencyKey,
    );
  }

  /**
   * DEV-ONLY: reports whether the wallet projection still equals the sum of
   * the ledger. The invariant this whole module is built around is only
   * worth stating if it can be checked, and this is how an operator (or the
   * e2e suite) checks it against real data.
   */
  @UseGuards(JwtAuthGuard, RewardsEnabledGuard, DevToolsGuard)
  @Get('dev/rewards/reconcile')
  reconcile(@CurrentUser() user: AuthenticatedUser) {
    return this.rewardsService.reconcile(user.id);
  }
}
