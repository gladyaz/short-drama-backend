/**
 * Work unit "REWARDS BACKEND FOUNDATION": the wire contract for `/rewards/*`.
 *
 * SHAPED TO MATCH THE MOBILE VIEW MODEL. The client's `RewardsSnapshot`
 * (`src/types/rewards.ts` in the mobile repo) already exists and its author
 * recorded the intent plainly: "the intended replacement path is a
 * `src/services/rewards/` module returning a `RewardsSnapshot` of the
 * existing shape. Because no component holds an economic value, that swap
 * should need no component changes." `RewardsSnapshotDto` below is built so
 * that mapping is a field rename at worst, never a restructure.
 *
 * TWO DELIBERATE DIFFERENCES FROM THE MOBILE TYPE, both in the same
 * direction — the server sends DATA, the client owns PRESENTATION:
 *
 * 1. NO `ctaLabel` / `resetsAtLabel` / `title` translations for UI chrome.
 *    The mobile app ships three languages and localises through `t()`. A
 *    backend that sent "Check in" would either force English on every locale
 *    or drag a translation catalog into this service. The client keeps
 *    owning its own copy; the server sends the facts the copy describes.
 * 2. NO `updatedAtLabel`. The mobile type says outright that it is
 *    "pre-formatted by the caller; this layer does no date formatting", so
 *    the server sends `updatedAt` as ISO-8601 and the client formats it.
 *
 * `isServerAuthoritative` IS sent, and is always `true`. It looks redundant
 * coming from a server — it exists because the mobile fixture set hardcoded
 * it `false`, and a snapshot that arrives with it `true` is how the client
 * distinguishes real state from the preview data it used to render. Leaving
 * the field out would make the flag unfalsifiable rather than unnecessary.
 */

export interface RewardWalletDto {
  balancePoints: number;
  lifetimeEarnedPoints: number;
  /** Always `true` from this backend — see the note above. */
  isServerAuthoritative: boolean;
  /** ISO-8601 UTC, or `null` for a wallet that has never moved. */
  updatedAt: string | null;
  /**
   * Optimistic-concurrency counter, incremented on every movement. Surfaced
   * so a client holding two snapshots can tell which is newer without
   * comparing timestamps (equal-second writes are possible).
   */
  version: number;
}

export type DailyCheckInDayState = 'CLAIMED' | 'TODAY' | 'UPCOMING';

export interface DailyCheckInDayDto {
  day: number;
  rewardPoints: number;
  state: DailyCheckInDayState;
  isBonus: boolean;
}

export interface DailyCheckInDto {
  currentStreakDays: number;
  longestStreakDays: number;
  totalCheckInDays: number;
  /** Points the NEXT successful check-in pays, per the cycle curve. */
  todayRewardPoints: number;
  isTodayClaimed: boolean;
  days: DailyCheckInDayDto[];
  /** `true` — check-in is the one fully server-verified earn path. */
  isClaimSupported: boolean;
  /**
   * The server's current reward date (`YYYY-MM-DD`) and the zone that
   * defines it. Sent so a client can display the boundary honestly instead
   * of guessing it from the device clock — which it must never do.
   */
  periodKey: string;
  timezone: string;
  /** ISO-8601 UTC instant at which the streak day rolls over. */
  resetsAt: string;
}

export type RewardTaskType =
  | 'DAILY_CHECK_IN'
  | 'SOCIAL_FOLLOW'
  | 'REWARDED_AD'
  | 'WATCH_TIME'
  /**
   * Work unit "REWARDS V1 EARN AND SPEND": a NEW member, and a new member
   * rather than a reuse of `WATCH_TIME` on purpose.
   *
   * The V1 watch mission counts DISTINCT EPISODES STARTED within a reward
   * day, measured from server-observed playback authorisations. It does not
   * measure time, and this backend cannot measure time (see
   * `WATCH_MISSION_DEFINITIONS`). Serving an episode count under a member
   * named `WATCH_TIME` would hand every downstream reader — the mobile UI,
   * a future analytics job, whoever reads the ledger next year — a unit that
   * is wrong.
   *
   * MOBILE MUST EXTEND ITS UNION to render these tiles. That is listed as
   * required integration work in `docs/rewards-api-contract.md` §11; a
   * client that does not know the member should skip the tile, not crash.
   */
  | 'WATCH_EPISODES'
  | 'CAMPAIGN';

export type RewardTaskStatus =
  'LOCKED' | 'AVAILABLE' | 'IN_PROGRESS' | 'CLAIMABLE' | 'COMPLETED';

export type SocialPlatform = 'FACEBOOK' | 'YOUTUBE' | 'TIKTOK' | 'INSTAGRAM';

/**
 * How strong the evidence behind a claimable task actually is. Sent on every
 * claimable task so a client can never present a claim as better-verified
 * than it is, and so the honesty of the surface is a DATA property rather
 * than a promise about how someone wrote the UI.
 *
 * - `USER_CONFIRMED` — the account holder said they did it. The server
 *   handed out the destination URL and saw them come back; it did NOT
 *   observe the external action. Every social mission is this.
 * - `SERVER_OBSERVED` — this backend itself performed or authorised the
 *   thing being rewarded. Check-in and the watch missions are this.
 *
 * There is deliberately no `PLATFORM_VERIFIED` member: nothing in V1 can
 * produce one, and a union member that nothing produces is an invitation to
 * produce it dishonestly.
 */
export type RewardTaskVerification = 'USER_CONFIRMED' | 'SERVER_OBSERVED';

/** Progress toward a counted mission. Server-computed; never client-supplied. */
export interface RewardTaskProgressDto {
  current: number;
  required: number;
}

export interface RewardTaskDto {
  id: string;
  type: RewardTaskType;
  rewardPoints: number;
  status: RewardTaskStatus;
  socialPlatform?: SocialPlatform;
  /**
   * `true` for the social and watch missions this backend can actually pay,
   * `false` for the task types that still have no server-verifiable
   * completion signal (see `docs/rewards-api-contract.md` §6). The flag is
   * server-owned, so the day a verifiable signal exists for the remaining
   * ones, existing clients start offering the claim without a mobile
   * release.
   */
  isClaimSupported: boolean;
  /**
   * Machine-readable reason `isClaimSupported` is false, so a client can
   * explain the state rather than showing a dead button. Never a
   * user-facing string — the client localises from this code.
   */
  unsupportedReason?: 'NO_VERIFIABLE_SIGNAL' | 'AWAITING_PRODUCT_DECISION';
  /** Present exactly when `isClaimSupported` is true. See the union's doc. */
  verification?: RewardTaskVerification;
  /**
   * Where a social mission sends the user. Comes from deployment
   * configuration, is validated at boot to be an https URL on that
   * platform's own domain, and is absent for every non-social task.
   */
  destinationUrl?: string;
  /**
   * The account handle to show beside the tile (`"@redpanda"`), derived from
   * `destinationUrl`. `undefined` when the URL shape carries no handle —
   * the client should fall back to the platform name rather than inventing
   * one.
   */
  accountHandle?: string;
  /** Present on counted missions (watch milestones). */
  progress?: RewardTaskProgressDto;
  /** ISO-8601 UTC of the claim, or `null` if this task has not been claimed. */
  claimedAt?: string | null;
  /**
   * ISO-8601 UTC at which a DAILY-RESETTING mission becomes claimable again.
   * Absent for one-time missions, whose completion is permanent.
   */
  resetsAt?: string;
}

export type RewardRedemptionAvailability =
  'AVAILABLE' | 'INSUFFICIENT_POINTS' | 'COMING_SOON';

export type RewardOfferKindDto = 'PREMIUM_DAYS' | 'AD_PERK';

export type RewardPerkTypeDto = 'SKIP_NEXT_INTERSTITIAL' | 'TEMPORARY_AD_PASS';

/** What an `AD_PERK` offer will issue, so the client can describe the purchase. */
export interface RewardOfferPerkDto {
  type: RewardPerkTypeDto;
  uses: number | null;
  durationMinutes: number;
}

export interface RewardRedemptionOfferDto {
  id: string;
  costPoints: number;
  grantsDays: number;
  availability: RewardRedemptionAvailability;
  isRedeemSupported: boolean;
  /** Work unit "REWARDS V1 EARN AND SPEND": what this offer hands over. */
  kind: RewardOfferKindDto;
  /** Present exactly when `kind === 'AD_PERK'`. */
  perk?: RewardOfferPerkDto;
  /**
   * Why an offer is `COMING_SOON`, machine-readable.
   *
   * `NOT_APPLICABLE_IN_FREE_MODE` is the honest answer for a VIP offer in a
   * deployment running `CONTENT_ACCESS_MODE=free`: every episode is already
   * free, so the offer would charge points and change nothing. The server
   * withholds it rather than selling it, and says which of the two reasons
   * applies so the client can word the tile correctly.
   */
  unavailableReason?: 'NOT_YET_LAUNCHED' | 'NOT_APPLICABLE_IN_FREE_MODE';
}

export interface RewardsSnapshotDto {
  wallet: RewardWalletDto;
  dailyCheckIn: DailyCheckInDto;
  /**
   * ALWAYS `null` in this slice, and that is a deliberate answer rather than
   * an omission. The mobile contract requires watch-time credit to come from
   * "server-side watch analytics"; this backend's only watch data is
   * `WatchProgress`, a per-series RESUME POSITION that decreases when a user
   * rewatches an episode. Summing it would not be watch time, it would be a
   * number that looks like watch time — the exact failure the mobile
   * `WatchTimeProgressSource` union was designed to prevent by refusing to
   * offer a `LOCAL_TIMER` member. `null` renders the section's empty state.
   */
  watchTime: null;
  tasks: RewardTaskDto[];
  redemptions: RewardRedemptionOfferDto[];
  /**
   * Work unit "REWARDS V1 EARN AND SPEND": the perks this account currently
   * holds, in the same read as everything else.
   *
   * SENT HERE AS WELL AS ON `GET /rewards/perks` on purpose. The Rewards
   * Center has to render "you have 1 ad skip" beside the offer that sells
   * one, and a second request to do it could interleave with a redemption
   * and show a balance that has paid for a perk the tile below does not yet
   * know about — the same reason the wallet and the streak strip travel
   * together. The dedicated route exists for the AD GATE, which asks far
   * more often and needs none of the rest of this payload.
   */
  activePerks: ActivePerksDto;
}

export interface CheckInResponseDto {
  /**
   * Points this call awarded. `0` on an idempotent replay — the caller had
   * already checked in today, so nothing moved.
   */
  awardedPoints: number;
  /**
   * `true` when this request was a replay of a check-in that had already
   * happened today. The HTTP status is 200 either way: a repeated check-in
   * is a successful no-op, not a client error, and returning 409 would push
   * clients into treating a double-tap as a failure to display.
   */
  alreadyCheckedIn: boolean;
  /** `null` only in the impossible case of a replay with no surviving entry. */
  ledgerEntryId: string | null;
  wallet: RewardWalletDto;
  dailyCheckIn: DailyCheckInDto;
}

export interface RewardLedgerEntryDto {
  id: string;
  deltaPoints: number;
  reason: string;
  sourceType: string;
  sourceId: string | null;
  balanceAfter: number;
  createdAt: string;
  metadata: unknown;
}

export interface RewardLedgerPageDto {
  entries: RewardLedgerEntryDto[];
  /**
   * Opaque cursor for the next page, or `null` at the end. Clients must
   * treat it as opaque and pass it back verbatim.
   */
  nextCursor: string | null;
}

export type RewardRedemptionStatus =
  'PENDING' | 'FULFILLED' | 'FAILED' | 'REVERSED';

export interface RedeemResponseDto {
  redemptionId: string;
  offerId: string;
  costPoints: number;
  grantsDays: number;
  status: RewardRedemptionStatus;
  /**
   * `true` when this request replayed an earlier redemption made with the
   * same idempotency key. Nothing was debited and no second entitlement or
   * perk was issued; the original receipt is returned.
   */
  replayed: boolean;
  wallet: RewardWalletDto;
  /** ISO-8601 UTC expiry of the premium the redemption granted/extended. */
  entitlementExpiresAt: string | null;
  /**
   * Work unit "REWARDS V1 EARN AND SPEND": the ad perk this redemption
   * issued, or `null` for a `PREMIUM_DAYS` offer. Exactly one of
   * `entitlementExpiresAt` / `perk` is non-null on a fulfilled receipt.
   */
  perk: RewardPerkDto | null;
}

/**
 * ---------------------------------------------------------------------------
 * MISSIONS — work unit "REWARDS V1 EARN AND SPEND"
 * ---------------------------------------------------------------------------
 */

/** Response of `POST /rewards/missions/:missionId/open`. */
export interface MissionOpenResponseDto {
  missionId: string;
  /** The URL the client should open in an external browser. Server-owned. */
  destinationUrl: string;
  /** ISO-8601 UTC instant the server recorded the open. */
  openedAt: string;
  /**
   * ISO-8601 UTC instant from which `POST .../claim` will be accepted.
   *
   * Sent so the client can disable its confirm button for the interval
   * rather than letting a user tap it and receive an error. It is NOT a
   * security boundary — the server re-checks it, and a script can simply
   * wait. See `SOCIAL_MISSION_MIN_DWELL_SECONDS`.
   */
  claimableAfter: string;
  /** The task tile, refreshed. Saves the client a snapshot round-trip. */
  task: RewardTaskDto;
}

/** Response of `POST /rewards/missions/:missionId/claim`. */
export interface MissionClaimResponseDto {
  missionId: string;
  /** Points this call awarded. `0` on an idempotent replay. */
  awardedPoints: number;
  /**
   * `true` when the mission had already been claimed (for a daily mission,
   * already claimed TODAY) and nothing moved. 200 either way, for the same
   * reason `POST /rewards/check-in` answers 200 on a repeat: a double-tap is
   * a successful no-op, not a failure a client should render.
   */
  alreadyClaimed: boolean;
  ledgerEntryId: string | null;
  wallet: RewardWalletDto;
  task: RewardTaskDto;
}

/**
 * ---------------------------------------------------------------------------
 * PERKS — work unit "REWARDS V1 EARN AND SPEND"
 * ---------------------------------------------------------------------------
 */

export interface RewardPerkDto {
  id: string;
  perkType: RewardPerkTypeDto;
  /** ISO-8601 UTC. Always set — every perk has a shelf life. */
  expiresAt: string;
  /** `1` for an unspent single-use perk; `null` for a duration pass. */
  remainingUses: number | null;
  /** ISO-8601 UTC of the redemption that issued it. */
  grantedAt: string;
}

/**
 * Response of `GET /rewards/perks` — the question the mobile ad-presentation
 * layer actually needs answered before deciding whether to show an
 * interstitial.
 *
 * THE TWO DERIVED BOOLEANS ARE THE POINT. A client that had to inspect
 * `perks[]` and reimplement "is a `SKIP_NEXT_INTERSTITIAL` active and
 * unexpired?" would be reimplementing a rule this server owns — and the two
 * implementations would drift, on a code path where drift means showing an
 * ad to someone who paid not to see one. The array is sent for display; the
 * booleans are what the ad gate reads.
 */
export interface ActivePerksDto {
  perks: RewardPerkDto[];
  /**
   * `true` when the caller holds an unexpired, unconsumed
   * `SKIP_NEXT_INTERSTITIAL`. The client should skip the next interstitial
   * AND call `POST /rewards/perks/:id/consume` when it does, so the spend is
   * recorded server-side.
   */
  skipNextInterstitial: boolean;
  /**
   * ISO-8601 UTC until which NO interstitial should be shown at all, from
   * the furthest-out active `TEMPORARY_AD_PASS`, or `null` if none is
   * active. Nothing needs to be consumed for this one — it is spent by the
   * clock.
   */
  adFreeUntil: string | null;
}

/** Response of `POST /rewards/perks/:perkId/consume`. */
export interface PerkConsumeResponseDto {
  perkId: string;
  /** `true` when THIS call spent the perk. */
  consumed: boolean;
  /**
   * `true` when the perk had already been spent, so this call changed
   * nothing. 200, not 409: a retried consume after a dropped response is the
   * normal case, and the client's correct reaction — "the perk is gone, show
   * ads again" — is the same either way.
   */
  alreadyConsumed: boolean;
  perks: ActivePerksDto;
}
