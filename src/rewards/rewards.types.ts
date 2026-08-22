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
  | 'CAMPAIGN';

export type RewardTaskStatus =
  'LOCKED' | 'AVAILABLE' | 'IN_PROGRESS' | 'CLAIMABLE' | 'COMPLETED';

export type SocialPlatform = 'FACEBOOK' | 'YOUTUBE' | 'TIKTOK' | 'INSTAGRAM';

export interface RewardTaskDto {
  id: string;
  type: RewardTaskType;
  rewardPoints: number;
  status: RewardTaskStatus;
  socialPlatform?: SocialPlatform;
  /**
   * `false` for every task this backend currently serves, and the server
   * refuses to pay any of them. See `docs/rewards-api-contract.md` §6: none
   * of the remaining task types has a signal this backend can verify, and a
   * reward that cannot be verified is a reward that can be farmed. The flag
   * is server-owned so the day a verifiable signal exists, existing clients
   * start offering the claim without a mobile release.
   */
  isClaimSupported: boolean;
  /**
   * Machine-readable reason `isClaimSupported` is false, so a client can
   * explain the state rather than showing a dead button. Never a
   * user-facing string — the client localises from this code.
   */
  unsupportedReason?: 'NO_VERIFIABLE_SIGNAL' | 'AWAITING_PRODUCT_DECISION';
}

export type RewardRedemptionAvailability =
  'AVAILABLE' | 'INSUFFICIENT_POINTS' | 'COMING_SOON';

export interface RewardRedemptionOfferDto {
  id: string;
  costPoints: number;
  grantsDays: number;
  availability: RewardRedemptionAvailability;
  isRedeemSupported: boolean;
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
   * same idempotency key. Nothing was debited and no second entitlement was
   * granted; the original receipt is returned.
   */
  replayed: boolean;
  wallet: RewardWalletDto;
  /** ISO-8601 UTC expiry of the premium the redemption granted/extended. */
  entitlementExpiresAt: string | null;
}
