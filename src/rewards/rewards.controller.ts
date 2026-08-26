import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
  REWARD_MISSION_RATE_LIMIT,
  REWARD_MISSION_RATE_TTL_MS,
  REWARD_PERK_CONSUME_RATE_LIMIT,
  REWARD_PERK_CONSUME_RATE_TTL_MS,
  REWARD_REDEEM_RATE_LIMIT,
  REWARD_REDEEM_RATE_TTL_MS,
} from '../common/rate-limit.constants';
import { DevToolsGuard } from '../entitlements/guards/dev-tools.guard';
import { DevGrantPointsDto } from './dto/dev-grant-points.dto';
import { RedeemRewardDto } from './dto/redeem-reward.dto';
import { RewardLedgerQueryDto } from './dto/reward-ledger-query.dto';
import { RewardsEnabledGuard } from './guards/rewards-enabled.guard';
import { RewardsMissionsService } from './rewards-missions.service';
import { RewardsPerksService } from './rewards-perks.service';
import { RewardsService } from './rewards.service';
import {
  ActivePerksDto,
  CheckInResponseDto,
  MissionClaimResponseDto,
  MissionOpenResponseDto,
  PerkConsumeResponseDto,
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
  constructor(
    private readonly rewardsService: RewardsService,
    private readonly missionsService: RewardsMissionsService,
    private readonly perksService: RewardsPerksService,
  ) {}

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
   * Work unit "REWARDS V1 EARN AND SPEND": records that the user is being
   * sent to a social profile, and returns the URL to send them to.
   *
   * TAKES NO BODY, and the URL in the RESPONSE is the one to open — never a
   * URL the client sends. A route that accepted a destination would let a
   * caller nominate where the app opens an external browser, which is a
   * phishing primitive handed out with the app's own branding on it.
   *
   * 200, not 201: the row it upserts is bookkeeping, not a resource the
   * caller created and can address.
   */
  @UseGuards(JwtAuthGuard, RewardsEnabledGuard)
  @Throttle({
    default: {
      limit: REWARD_MISSION_RATE_LIMIT,
      ttl: REWARD_MISSION_RATE_TTL_MS,
    },
  })
  @HttpCode(HttpStatus.OK)
  @Post('rewards/missions/:missionId/open')
  openMission(
    @CurrentUser() user: AuthenticatedUser,
    @Param('missionId') missionId: string,
  ): Promise<MissionOpenResponseDto> {
    return this.missionsService.openMission(user.id, missionId);
  }

  /**
   * Work unit "REWARDS V1 EARN AND SPEND": claims a social mission (the user
   * confirming they did the external action) or a watch milestone.
   *
   * TAKES NO BODY, exactly like `POST /rewards/check-in` and for the same
   * reason: the amount is the server's, the reward day is the server's, and
   * the idempotency key is derived from the mission id (plus the period, for
   * a daily mission). There is nothing a client could send that would change
   * the outcome — including which mission it is, which comes from the path
   * and is resolved against the catalog before anything is paid.
   *
   * 200 in both cases. A repeat claim is `alreadyClaimed: true` with
   * `awardedPoints: 0`, not a 409 — a double-tap is a successful no-op.
   */
  @UseGuards(JwtAuthGuard, RewardsEnabledGuard)
  @Throttle({
    default: {
      limit: REWARD_MISSION_RATE_LIMIT,
      ttl: REWARD_MISSION_RATE_TTL_MS,
    },
  })
  @HttpCode(HttpStatus.OK)
  @Post('rewards/missions/:missionId/claim')
  claimMission(
    @CurrentUser() user: AuthenticatedUser,
    @Param('missionId') missionId: string,
  ): Promise<MissionClaimResponseDto> {
    return this.missionsService.claimMission(user.id, missionId);
  }

  /**
   * Work unit "REWARDS V1 EARN AND SPEND": the question the mobile ad layer
   * asks before showing an interstitial — "does this account hold a perk
   * that says not to?"
   *
   * Deliberately SEPARATE from `/rewards/snapshot` even though the snapshot
   * carries the same object: the ad gate consults this far more often than
   * anyone opens the Rewards Center, and making it pay for a wallet read, a
   * streak read, a mission-state read and a `COUNT` every time would be a
   * tax on every ad break.
   *
   * No `@Throttle()` override — see `REWARD_PERK_CONSUME_RATE_LIMIT`'s doc
   * for why a read on the ad path keeps the generous app-wide default.
   */
  @UseGuards(JwtAuthGuard, RewardsEnabledGuard)
  @Get('rewards/perks')
  getPerks(@CurrentUser() user: AuthenticatedUser): Promise<ActivePerksDto> {
    return this.perksService.getActivePerks(user.id);
  }

  /**
   * Work unit "REWARDS V1 EARN AND SPEND": spends a single-use ad-skip perk.
   *
   * THE CLIENT MUST CALL THIS WHEN IT ACTUALLY SKIPS. A perk that the app
   * "uses" by quietly not showing an ad is a perk the server still believes
   * the user holds — the balance and the entitlement would disagree with
   * what the user experienced, and the next ad break would skip again for
   * free. Recording the spend server-side is what makes "you bought one
   * skip" true.
   *
   * 200 with `alreadyConsumed: true` on a repeat, not 409: a retried consume
   * after a dropped response is the ordinary case, and the client's correct
   * reaction is identical either way.
   */
  @UseGuards(JwtAuthGuard, RewardsEnabledGuard)
  @Throttle({
    default: {
      limit: REWARD_PERK_CONSUME_RATE_LIMIT,
      ttl: REWARD_PERK_CONSUME_RATE_TTL_MS,
    },
  })
  @HttpCode(HttpStatus.OK)
  @Post('rewards/perks/:perkId/consume')
  async consumePerk(
    @CurrentUser() user: AuthenticatedUser,
    @Param('perkId') perkId: string,
  ): Promise<PerkConsumeResponseDto> {
    const outcome = await this.perksService.consume(user.id, perkId);

    return {
      perkId,
      consumed: outcome.consumed,
      alreadyConsumed: outcome.alreadyConsumed,
      // The refreshed set, so a client never has to guess what it holds
      // after spending something.
      perks: await this.perksService.getActivePerks(user.id),
    };
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
