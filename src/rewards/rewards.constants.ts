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
  /**
   * Days of premium this offer buys. `0` for an `AD_PERK` offer, which buys
   * an ad perk and no premium at all — the migration relaxes the old
   * `grantsDays > 0` CHECK to `>= 0` for exactly this case.
   */
  readonly grantsDays: number;
  /**
   * Work unit "REWARDS V1 EARN AND SPEND": what this offer actually hands
   * over.
   *
   * `PREMIUM_DAYS` is the foundation slice's original behaviour, unchanged.
   * `AD_PERK` is V1's answer to "coins must buy something in an app with no
   * paywall": the thing worth buying is relief from ads, not access to
   * content that is already free.
   */
  readonly kind: RewardOfferKind;
  /** Present exactly when `kind === 'AD_PERK'`. */
  readonly perk?: RewardPerkGrantSpec;
  /**
   * `false` parks an offer in the catalog as visible-but-not-purchasable —
   * the mobile `COMING_SOON` availability state. A disabled offer is refused
   * server-side (`REWARD_OFFER_UNAVAILABLE`), never merely hidden in the UI,
   * so a client that ignores the flag still cannot buy it.
   */
  readonly isEnabled: boolean;
}

export type RewardOfferKind = 'PREMIUM_DAYS' | 'AD_PERK';

/**
 * What an `AD_PERK` offer issues. Read by `RewardsPerksService.issuePerk`,
 * which is the only writer of `RewardPerk`.
 */
export interface RewardPerkGrantSpec {
  readonly type: RewardPerkType;
  /**
   * `1` for a single-use perk (an ad skip), `null` for a duration pass whose
   * only limit is the clock. Never `0`.
   */
  readonly uses: number | null;
  /**
   * Shelf life, in minutes, from the moment of redemption.
   *
   * A SINGLE-USE PERK HAS ONE TOO, deliberately. An ad skip bought today and
   * never spent is an open-ended liability against an ad configuration that
   * will have changed by the time it is used, and "it expires in a day"
   * is a promise a user can plan around. A perk with no expiry is a promise
   * no one can price.
   */
  readonly durationMinutes: number;
}

/**
 * The redemption catalog. Costs are SNAPSHOTTED onto the `RewardRedemption`
 * row at redemption time (mobile contract §2, `RewardRedemption.costPoints`
 * — "snapshotted at redemption time, so a later price change never rewrites
 * history"), so editing a price here changes what future redemptions cost
 * and leaves every past one exactly as it was.
 */
export const REWARD_REDEMPTION_OFFERS: readonly RewardRedemptionOffer[] = [
  // ---------------------------------------------------------------------
  // AD PERKS — the V1 spend path. Listed FIRST because in a free,
  // ads-monetised app these are the offers that actually mean something;
  // the VIP block below is suppressed entirely while
  // `CONTENT_ACCESS_MODE=free` (see `isOfferApplicable`).
  // ---------------------------------------------------------------------
  {
    id: 'redeem_skip_next_ad',
    title: 'Skip one ad',
    description: 'Skip the next interstitial ad.',
    costPoints: 150,
    grantsDays: 0,
    kind: 'AD_PERK',
    perk: {
      type: 'SKIP_NEXT_INTERSTITIAL',
      uses: 1,
      // 24h. Long enough that a user who buys one and closes the app still
      // has it tomorrow; short enough that it is not an open-ended IOU.
      durationMinutes: 24 * 60,
    },
    isEnabled: true,
  },
  {
    id: 'redeem_ad_pass_2h',
    title: '2 hours ad-free',
    description: 'No interstitial ads for two hours.',
    costPoints: 600,
    grantsDays: 0,
    kind: 'AD_PERK',
    perk: {
      type: 'TEMPORARY_AD_PASS',
      uses: null,
      durationMinutes: 120,
    },
    isEnabled: true,
  },
  // ---------------------------------------------------------------------
  // PREMIUM DAYS — unchanged from the foundation slice, and deliberately
  // still here. V1 ships with `CONTENT_ACCESS_MODE=free`, under which these
  // sell nothing and are therefore suppressed; a deployment that turns the
  // paywall back on gets them back with no code change and no lost history.
  // ---------------------------------------------------------------------
  {
    id: 'redeem_vip_1d',
    title: 'VIP 1 Day',
    description: 'Unlock every premium episode for 24 hours.',
    costPoints: 1000,
    grantsDays: 1,
    kind: 'PREMIUM_DAYS',
    isEnabled: true,
  },
  {
    id: 'redeem_vip_3d',
    title: 'VIP 3 Days',
    description: 'Unlock every premium episode for 3 days.',
    costPoints: 2500,
    grantsDays: 3,
    kind: 'PREMIUM_DAYS',
    isEnabled: true,
  },
  {
    id: 'redeem_vip_7d',
    title: 'VIP 7 Days',
    description: 'Unlock every premium episode for a week.',
    costPoints: 5000,
    grantsDays: 7,
    kind: 'PREMIUM_DAYS',
    isEnabled: false,
  },
];

/**
 * Whether an offer means anything in a deployment running `accessMode`.
 *
 * WHY THIS EXISTS. `CONTENT_ACCESS_MODE=free` — the V1 posture — makes every
 * episode free regardless of its per-row tier. A `PREMIUM_DAYS` offer in that
 * deployment charges 1000 points to "unlock every premium episode" when
 * there is nothing locked: the user pays, the entitlement row is written, and
 * absolutely nothing about their experience changes. Selling that is selling
 * nothing, and no amount of careful wording in a description makes it
 * otherwise.
 *
 * So the offer is withheld rather than reworded. `buildRedemptions` reports
 * it as `COMING_SOON` with `unavailableReason: 'NOT_APPLICABLE_IN_FREE_MODE'`
 * and `redeem` refuses it server-side — the same shape as `isEnabled: false`,
 * because from a client's point of view it is the same situation: a real
 * tile that is not currently purchasable.
 *
 * `AD_PERK` offers are applicable in EVERY mode. Ads are shown to everyone
 * the ad config says to show them to, and that has nothing to do with the
 * content access policy.
 */
export function isOfferApplicable(
  offer: RewardRedemptionOffer,
  accessMode: string,
): boolean {
  if (offer.kind !== 'PREMIUM_DAYS') {
    return true;
  }

  return accessMode !== 'free';
}

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
  /**
   * Work unit "REWARDS V1 EARN AND SPEND". Credit for a social mission.
   *
   * NAMED FOR WHAT THE SERVER ACTUALLY OBSERVED. It is NOT `VERIFIED_FOLLOW`
   * and must never become one while the only evidence is a user tapping
   * "I followed": no platform in this catalog exposes a follow check for an
   * arbitrary user, so the server knows an EXTERNAL ACTION was reported by
   * the account holder and nothing more. A ledger is the last place in a
   * system where a name should overstate the evidence behind it — every
   * downstream report inherits the claim, and no one re-derives it.
   */
  EXTERNAL_SOCIAL_ACTION: 'EXTERNAL_SOCIAL_ACTION',
  /**
   * Work unit "REWARDS V1 EARN AND SPEND". Credit for reaching an
   * episodes-started milestone within one reward day, counted from
   * SERVER-OBSERVED playback authorisations (`RewardWatchCredit`) — never
   * from a client-reported position or duration.
   */
  WATCH_MILESTONE: 'WATCH_MILESTONE',
  /**
   * Work unit "REWARDS V1 EARN AND SPEND". Debit for an ad perk. Distinct
   * from `VIP_REDEMPTION` because the two buy genuinely different things,
   * and a statement that called both "VIP" would make the one earn/spend
   * report anyone actually reads unreadable.
   */
  AD_PERK_REDEMPTION: 'AD_PERK_REDEMPTION',
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
  /** Work unit "REWARDS V1 EARN AND SPEND". `sourceId` is the mission id. */
  SOCIAL_MISSION: 'SOCIAL_MISSION',
  /** Work unit "REWARDS V1 EARN AND SPEND". `sourceId` is the mission id. */
  WATCH_MISSION: 'WATCH_MISSION',
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
 * ---------------------------------------------------------------------------
 * WATCH MISSIONS — work unit "REWARDS V1 EARN AND SPEND"
 * ---------------------------------------------------------------------------
 *
 * NAMED FOR EPISODES STARTED, NOT FOR WATCH TIME, and the distinction is the
 * whole reason these are payable when the foundation slice's `watchTime`
 * section is still `null`.
 *
 * This backend has no trustworthy measure of watch DURATION. Its only
 * duration-shaped data is `WatchProgress.positionSeconds`, a resume marker a
 * DEVICE writes and that DECREASES when a user rewatches — summing it would
 * produce a number that looks like watch time and is not, which is exactly
 * the failure the mobile `WatchTimeProgressSource` union was designed to
 * prevent.
 *
 * What the server does know first-hand is that IT authorised playback of a
 * given episode for a given account (`RewardWatchCredit`, written from the
 * playback path — never from a request body). Counting DISTINCT episodes so
 * authorised within one reward day is a claim this backend can actually
 * stand behind, so that is the claim the mission makes.
 *
 * RESET DAILY. These are the app's habit loop, alongside the check-in, so the
 * ledger key carries the period (`WATCH_MILESTONE:<missionId>:<periodKey>`)
 * and yesterday's claim does not block today's.
 */
export interface WatchMissionDefinition {
  readonly id: string;
  /** Distinct episodes that must be started, within one reward day. */
  readonly requiredEpisodes: number;
  readonly rewardPoints: number;
}

/**
 * Two rungs, deliberately: the first is reachable in a single sitting so the
 * mission is not theatre, and the second is worth continuing for. Adding a
 * third is an edit to this array — nothing downstream counts them.
 */
export const WATCH_MISSION_DEFINITIONS: readonly WatchMissionDefinition[] = [
  { id: 'task_watch_3_episodes', requiredEpisodes: 3, rewardPoints: 30 },
  { id: 'task_watch_5_episodes', requiredEpisodes: 5, rewardPoints: 50 },
];

/**
 * `RewardMissionClaim.missionType` — which family a claim row belongs to.
 * Stored rather than re-derived from the id, so a row stays interpretable if
 * a mission is ever retired from the catalog.
 */
export const REWARD_MISSION_TYPES = {
  SOCIAL: 'SOCIAL',
  WATCH: 'WATCH',
} as const;

export type RewardMissionType =
  (typeof REWARD_MISSION_TYPES)[keyof typeof REWARD_MISSION_TYPES];

/**
 * `RewardMissionClaim.periodKey` for a mission that can be claimed ONCE, ever.
 *
 * A sentinel rather than `NULL` because Postgres does not treat two NULLs as
 * equal in a unique index: a nullable column here would silently allow two
 * "one-time" claim rows for the same mission, which is precisely what the
 * index exists to prevent.
 */
export const ONE_TIME_MISSION_PERIOD_KEY = '*';

export function findWatchMissionDefinition(
  missionId: string,
): WatchMissionDefinition | undefined {
  return WATCH_MISSION_DEFINITIONS.find((mission) => mission.id === missionId);
}

/**
 * How a `RewardWatchCredit` came to exist. One member today; the column
 * exists so a future, stronger signal (an ad-network-style server callback,
 * a heartbeat with a server-issued nonce) is distinguishable in the data
 * rather than silently merged into this one.
 */
export const REWARD_WATCH_CREDIT_SOURCES = {
  /** This backend authorised playback of the episode for this account. */
  PLAYBACK_GRANT: 'PLAYBACK_GRANT',
} as const;

/**
 * ---------------------------------------------------------------------------
 * AD PERKS — work unit "REWARDS V1 EARN AND SPEND"
 * ---------------------------------------------------------------------------
 *
 * What points BUY in a free, ads-monetised V1. The BACKEND owns issuance,
 * expiry and consumption; the mobile ad-presentation layer only ASKS
 * (`GET /rewards/perks`) and REPORTS a spend (`POST /rewards/perks/:id/consume`).
 *
 * No AdMob SDK, no ad-network integration and no ad-serving decision lives
 * here — this module knows nothing about which ad would have been shown. It
 * answers one question: does this account currently hold a perk that says an
 * interstitial should be skipped?
 */
export const REWARD_PERK_TYPES = {
  /**
   * Skips ONE interstitial. Single-use, spent by an explicit consume call so
   * the spend is recorded server-side rather than being a client deciding
   * quietly not to show an ad.
   */
  SKIP_NEXT_INTERSTITIAL: 'SKIP_NEXT_INTERSTITIAL',
  /** Suppresses interstitials until `expiresAt`. Spent by the clock alone. */
  TEMPORARY_AD_PASS: 'TEMPORARY_AD_PASS',
} as const;

export type RewardPerkType =
  (typeof REWARD_PERK_TYPES)[keyof typeof REWARD_PERK_TYPES];

export const REWARD_PERK_STATUSES = {
  ACTIVE: 'ACTIVE',
  CONSUMED: 'CONSUMED',
  /**
   * Written only when something OBSERVES the expiry (a read, a consume
   * attempt). Liveness is always re-derived from `expiresAt` against the
   * clock, never trusted from this column — so a perk is never treated as
   * live merely because no sweeper has run.
   */
  EXPIRED: 'EXPIRED',
} as const;

export type RewardPerkStatus =
  (typeof REWARD_PERK_STATUSES)[keyof typeof REWARD_PERK_STATUSES];

/**
 * The task catalog the Rewards Center renders for the task types that STILL
 * have no server-verifiable completion signal.
 *
 * Work unit "REWARDS V1 EARN AND SPEND" REMOVED the social entries from this
 * list — they are now first-class, claimable missions built from
 * `SOCIAL_MISSION_DEFINITIONS` and the deployment's configured URLs. What
 * remains here is what genuinely cannot be paid:
 *
 * - REWARDED_AD — must be credited "only from the ad network's server-side
 *   verification callback, keyed on its transaction id". No such callback is
 *   wired into this backend: the entire ads surface is `GET /config/ads`, a
 *   read-only frequency-capping config with no callback endpoint, no shared
 *   secret and no transaction id. Crediting a client-sent "the ad finished"
 *   message is crediting an untrusted device, and the device in question has
 *   an obvious incentive to lie.
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
  readonly type: 'REWARDED_AD' | 'CAMPAIGN';
  readonly rewardPoints: number;
  readonly status: 'AVAILABLE' | 'LOCKED';
  readonly isClaimSupported: boolean;
  readonly unsupportedReason:
    'NO_VERIFIABLE_SIGNAL' | 'AWAITING_PRODUCT_DECISION';
}

export const REWARD_TASK_DEFINITIONS: readonly RewardTaskDefinition[] = [
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
