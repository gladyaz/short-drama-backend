import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RootConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { toPeriodKey } from './reward-period.util';
import { REWARD_WATCH_CREDIT_SOURCES } from './rewards.constants';

/**
 * Work unit "REWARDS V1 EARN AND SPEND": the ONLY writer of
 * `RewardWatchCredit`, and the boundary between "the app played something"
 * and "the rewards economy believes it".
 *
 * ---------------------------------------------------------------------------
 * WHAT COUNTS, AND WHY IT IS NOT WHAT THE CLIENT SAYS
 *
 * The obvious source for a watch mission is `PUT /series/:id/progress`, which
 * the app already calls with a position and a duration. It is the wrong one,
 * and not marginally: `positionSeconds` is a number the DEVICE chooses. A
 * mission funded from it pays whatever the device claims, and the device has
 * an incentive to claim a lot. The mobile domain contract says the same thing
 * from the other side by refusing to offer a `LOCAL_TIMER` member on its
 * `WatchTimeProgressSource` union.
 *
 * So the signal is one this backend produces ITSELF: a successful
 * authorisation of playback for a specific episode by a specific account, in
 * `VideosController.getPlaybackUrl`, AFTER `enforceEntitlementGate` has said
 * yes. Nothing in the request body contributes — the caller identity comes
 * from the verified token and the episode from the path.
 *
 * WHAT THIS PROVES, EXACTLY. That the server decided this account could play
 * this episode and handed it a URL. NOT that bytes were fetched, that
 * anything rendered, or for how long. The mission is therefore named for
 * EPISODES STARTED (`WATCH_EPISODES`) and never for watch time, and
 * `docs/rewards-api-contract.md` §5 states the same limit in the same words.
 * A stronger signal — a heartbeat carrying a server-issued nonce, an
 * ad-network-style server callback — would slot in as a second
 * `REWARD_WATCH_CREDIT_SOURCES` member without changing anything downstream.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS CAN NEVER BREAK PLAYBACK
 *
 * `recordEpisodeStart` swallows and logs its own failures. That is a
 * deliberate exception to "never swallow an error", and the reasoning is a
 * priority ordering rather than a shrug: this call sits on the playback path,
 * and a rewards bug, a lock wait, or a full disk must never be the reason a
 * viewer cannot watch an episode. Losing one watch credit costs a user a few
 * points on one mission; failing the playback request costs them the product.
 * The failure is logged at `warn` with the id needed to find it, so it is
 * quiet, not silent.
 */
@Injectable()
export class RewardsWatchService {
  private readonly logger = new Logger(RewardsWatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<RootConfig>,
  ) {}

  /**
   * Records that the server authorised playback of `videoId` for `userId`.
   *
   * IDEMPOTENT BY CONSTRUCTION, and this is the anti-farming control: the
   * unique key is `(userId, periodKey, videoId)`, so replaying
   * `GET /videos/:id/playback` for the same episode a thousand times in a day
   * produces exactly one credit. Progress can only advance by reaching for a
   * DIFFERENT episode, which is the behaviour the mission is trying to
   * reward in the first place.
   *
   * Uses `createMany({ skipDuplicates })` rather than an upsert: there is
   * nothing to update on a repeat — the row records that a thing happened,
   * and it happened once.
   */
  async recordEpisodeStart(input: WatchCreditInput): Promise<void> {
    if (!this.isEnabled()) {
      // A deployment with rewards dark writes NO reward table at all — the
      // same posture `RewardsEnabledGuard` takes on the `/rewards/*` routes.
      // Turning the feature on later therefore starts from a clean, empty
      // history rather than from months of silently-accumulated credits.
      return;
    }

    try {
      const periodKey = toPeriodKey(new Date(), this.timezone());

      await this.prisma.rewardWatchCredit.createMany({
        data: [
          {
            userId: input.userId,
            periodKey,
            videoId: input.videoId,
            seriesId: input.seriesId ?? null,
            episodeNumber: input.episodeNumber ?? null,
            source: REWARD_WATCH_CREDIT_SOURCES.PLAYBACK_GRANT,
          },
        ],
        skipDuplicates: true,
      });
    } catch (error) {
      // See the class doc: rewards accounting must never fail playback.
      this.logger.warn(
        `Could not record a watch credit for video "${input.videoId}": ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  /**
   * Distinct episodes this account started during `periodKey` — the number
   * every watch mission's progress is measured against.
   *
   * A COUNT, not a stored counter. The credits are the source of truth and
   * the count is derived on read, so there is no second number that can
   * disagree with them — the same discipline `RewardsWalletService.reconcile`
   * applies to the balance, applied where it is cheap enough to do on every
   * read.
   */
  countEpisodesStarted(userId: string, periodKey: string): Promise<number> {
    return this.prisma.rewardWatchCredit.count({
      where: { userId, periodKey },
    });
  }

  /** The service-timezone reward day containing `now`. */
  currentPeriodKey(now = new Date()): string {
    return toPeriodKey(now, this.timezone());
  }

  private isEnabled(): boolean {
    return this.configService.get('rewards', { infer: true })?.enabled === true;
  }

  private timezone(): string {
    return this.configService.get('rewards', { infer: true })!.timezone;
  }
}

export interface WatchCreditInput {
  readonly userId: string;
  readonly videoId: string;
  /** Recorded for reporting only; never part of the uniqueness rule. */
  readonly seriesId?: string | null;
  readonly episodeNumber?: number | null;
}
