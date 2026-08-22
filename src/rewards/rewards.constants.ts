/**
 * Work unit "REWARDS BACKEND FOUNDATION": the single source of truth for
 * every economic value in the rewards domain — the daily check-in curve,
 * the redemption catalog, and the service timezone that defines "today".
 *
 * WHY EVERY NUMBER LIVES HERE AND NOWHERE ELSE. The mobile client's
 * `rewards-fixtures.ts` carried these values as PLACEHOLDER fixtures with a
 * header stating they are "NOT PRODUCT-APPROVED" and that "when the backend
 * lands, this file is replaced by a service response of the same shape".
 * This file is that replacement. The client now renders numbers it is told;
 * it no longer owns any of them, which is what makes the economics tunable
 * without a mobile release (mobile `docs/rewards-domain-contract.md` §2,
 * "keep the configuration separate from the per-user state").
 *
 * THE VALUES THEMSELVES ARE STILL NOT PRODUCT-APPROVED. They are carried
 * over verbatim from the mobile fixture set so the local Android demo shows
 * the same figures it always did. What changed is WHERE they are decided
 * (server) and whether they are ENFORCED (they now are — a claim pays
 * exactly `CHECK_IN_REWARD_CURVE[dayInCycle - 1]` and a redemption debits
 * exactly `costPoints`, both snapshotted onto immutable ledger rows). See
 * `docs/rewards-api-contract.md` §7 for the open product decisions that
 * must be settled before these numbers mean anything commercially.
 */

/**
 * Length of the repeating check-in cycle, in days. A streak of 7 rolls back
 * to day 1 of a fresh cycle (the reward curve repeats); it does NOT cap the
 * streak counter itself, which keeps climbing so `longestStreakDays` stays
 * meaningful.
 */
export const CHECK_IN_CYCLE_LENGTH = 7;

/**
 * Points paid for each day of the cycle, indexed by `dayInCycle - 1`. Day 7
 * is the streak-bonus day the mobile UI renders with its bonus accent
 * (`DailyCheckInDay.isBonus`), which is why it steps up sharply rather than
 * continuing the linear ramp.
 *
 * MUST have exactly `CHECK_IN_CYCLE_LENGTH` entries — `rewards.constants.spec.ts`
 * asserts this, because a short array would otherwise pay `undefined` points
 * (a `NaN` ledger delta) on the missing day.
 */
export const CHECK_IN_REWARD_CURVE: readonly number[] = [
  10, 15, 20, 25, 30, 40, 100,
];

/** The 1-based cycle day rendered with the streak-bonus accent. */
export const CHECK_IN_BONUS_DAY = 7;

/**
 * A redemption offer: a fixed number of points converted into a fixed number
 * of days of the EXISTING account-wide premium entitlement. Deliberately not
 * a new benefit type — the mobile contract §5 requires that redeeming grants
 * an entitlement through the same system everything else uses, in the same
 * transaction as the debit, so there is no second, parallel premium concept
 * to keep in sync.
 */
export interface RewardRedemptionOffer {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly costPoints: number;
  readonly grantsDays: number;
  /**
   * `false` parks an offer in the catalog as visible-but-not-purchasable —
   * the mobile `COMING_SOON` availability state. A disabled offer is refused
   * server-side (`REWARD_OFFER_UNAVAILABLE`), never merely hidden in the UI,
   * so a client that ignores the flag still cannot buy it.
   */
  readonly isEnabled: boolean;
}

/**
 * The redemption catalog. Costs are SNAPSHOTTED onto the `RewardRedemption`
 * row at redemption time (mobile contract §2, `RewardRedemption.costPoints`
 * — "snapshotted at redemption time, so a later price change never rewrites
 * history"), so editing a price here changes what future redemptions cost
 * and leaves every past one exactly as it was.
 */
export const REWARD_REDEMPTION_OFFERS: readonly RewardRedemptionOffer[] = [
  {
    id: 'redeem_vip_1d',
    title: 'VIP 1 Day',
    description: 'Unlock every premium episode for 24 hours.',
    costPoints: 1000,
    grantsDays: 1,
    isEnabled: true,
  },
  {
    id: 'redeem_vip_3d',
    title: 'VIP 3 Days',
    description: 'Unlock every premium episode for 3 days.',
    costPoints: 2500,
    grantsDays: 3,
    isEnabled: true,
  },
  {
    id: 'redeem_vip_7d',
    title: 'VIP 7 Days',
    description: 'Unlock every premium episode for a week.',
    costPoints: 5000,
    grantsDays: 7,
    isEnabled: false,
  },
];

export function findRedemptionOffer(
  offerId: string,
): RewardRedemptionOffer | undefined {
  return REWARD_REDEMPTION_OFFERS.find((offer) => offer.id === offerId);
}

/**
 * `RewardLedgerEntry.reason` — a CLOSED set (mobile contract §3: "adding a
 * member is a deliberate product decision, not an incidental code change").
 * Stored as a plain string column, matching the `Entitlement.tier` /
 * `PaymentOrder.status` precedent in this schema rather than introducing a
 * Postgres enum.
 *
 * Only the members this slice can actually PRODUCE are listed. `SOCIAL_TASK`,
 * `REWARDED_AD` and `WATCH_TIME` from the mobile contract are deliberately
 * ABSENT: none of them has a server-verifiable signal behind it today (see
 * `docs/rewards-api-contract.md` §6), and defining a reason code for an
 * unearnable credit would invite a future caller to pay it.
 */
export const REWARD_REASONS = {
  DAILY_CHECK_IN: 'DAILY_CHECK_IN',
  VIP_REDEMPTION: 'VIP_REDEMPTION',
  /** Manual credit/debit. Dev-tools only in this slice. */
  ADJUSTMENT: 'ADJUSTMENT',
  /** Compensating entry; references the reversed entry in `metadata`. */
  REVERSAL: 'REVERSAL',
} as const;

export type RewardReason = (typeof REWARD_REASONS)[keyof typeof REWARD_REASONS];

/** `RewardLedgerEntry.sourceType` — what kind of thing produced the entry. */
export const REWARD_SOURCE_TYPES = {
  CHECK_IN: 'CHECK_IN',
  REDEMPTION: 'REDEMPTION',
  DEV_TOOL: 'DEV_TOOL',
} as const;

export type RewardSourceType =
  (typeof REWARD_SOURCE_TYPES)[keyof typeof REWARD_SOURCE_TYPES];

/**
 * `Entitlement.source` written by a redemption-funded grant, distinguishing
 * it from `"dev-grant"` and from the payment sources in
 * `payment-plan.constants.ts`. Lets an operator answer "was this premium
 * bought, earned, or granted by hand?" from the entitlement row alone.
 */
export const REWARD_ENTITLEMENT_SOURCE = 'reward-redemption';

/**
 * Upper bound on a single dev-tools point grant. Not a security control (the
 * route is already unreachable unless `DEV_TOOLS_ENABLED=true`, which the
 * app refuses to boot with outside `development`/`test`) — it exists so a
 * fat-fingered demo grant cannot push a wallet to a value that makes the
 * `balanceAfter` arithmetic hard to reason about in the ledger view.
 */
export const DEV_GRANT_MAX_POINTS = 100_000;

/** Default and maximum page sizes for `GET /rewards/ledger`. */
export const LEDGER_PAGE_SIZE_DEFAULT = 20;
export const LEDGER_PAGE_SIZE_MAX = 100;

/**
 * The task catalog the Rewards Center renders.
 *
 * EVERY ENTRY IS UNCLAIMABLE, and that is the point of this slice being
 * honest rather than complete. The mobile domain contract §5 works through
 * each of these and reaches the same conclusion:
 *
 * - SOCIAL_FOLLOW — "currently unverifiable ... Facebook, YouTube, TikTok and
 *   Instagram do not offer a 'did user X follow page Y' check for arbitrary
 *   users." Opening a profile link proves a link was opened, nothing more.
 *   Paying for it is a founder decision (§5, options 1-3), not an
 *   engineering one, so nothing here pays it.
 * - REWARDED_AD — must be credited "only from the ad network's server-side
 *   verification callback, keyed on its transaction id". No such callback is
 *   wired into this backend, and crediting a client-sent "the ad finished"
 *   message is crediting an untrusted device.
 * - CAMPAIGN — has no defined completion signal at all yet.
 *
 * WHY SERVE THEM AT ALL RATHER THAN AN EMPTY LIST. The tiles are real product
 * surface the client already renders, and serving them with a SERVER-OWNED
 * `isClaimSupported: false` moves the availability decision off the device
 * for good: the day a verifiable signal exists, flipping it here makes every
 * installed client offer the claim with no mobile release. An empty list
 * would instead push the client back into deciding what exists.
 */
export interface RewardTaskDefinition {
  readonly id: string;
  readonly type: 'SOCIAL_FOLLOW' | 'REWARDED_AD' | 'CAMPAIGN';
  readonly rewardPoints: number;
  readonly status: 'AVAILABLE' | 'LOCKED';
  readonly socialPlatform?: 'FACEBOOK' | 'YOUTUBE' | 'TIKTOK' | 'INSTAGRAM';
  readonly isClaimSupported: boolean;
  readonly unsupportedReason:
    'NO_VERIFIABLE_SIGNAL' | 'AWAITING_PRODUCT_DECISION';
}

export const REWARD_TASK_DEFINITIONS: readonly RewardTaskDefinition[] = [
  {
    id: 'task_social_facebook',
    type: 'SOCIAL_FOLLOW',
    socialPlatform: 'FACEBOOK',
    rewardPoints: 50,
    status: 'AVAILABLE',
    isClaimSupported: false,
    unsupportedReason: 'NO_VERIFIABLE_SIGNAL',
  },
  {
    id: 'task_social_youtube',
    type: 'SOCIAL_FOLLOW',
    socialPlatform: 'YOUTUBE',
    rewardPoints: 50,
    status: 'AVAILABLE',
    isClaimSupported: false,
    unsupportedReason: 'NO_VERIFIABLE_SIGNAL',
  },
  {
    id: 'task_social_tiktok',
    type: 'SOCIAL_FOLLOW',
    socialPlatform: 'TIKTOK',
    rewardPoints: 50,
    status: 'AVAILABLE',
    isClaimSupported: false,
    unsupportedReason: 'NO_VERIFIABLE_SIGNAL',
  },
  {
    id: 'task_rewarded_ad',
    type: 'REWARDED_AD',
    rewardPoints: 20,
    status: 'AVAILABLE',
    isClaimSupported: false,
    unsupportedReason: 'NO_VERIFIABLE_SIGNAL',
  },
  {
    id: 'task_campaign_placeholder',
    type: 'CAMPAIGN',
    rewardPoints: 150,
    status: 'LOCKED',
    isClaimSupported: false,
    unsupportedReason: 'AWAITING_PRODUCT_DECISION',
  },
];
