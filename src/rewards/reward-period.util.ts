import { CHECK_IN_CYCLE_LENGTH } from './rewards.constants';

/**
 * Work unit "REWARDS BACKEND FOUNDATION": the server's definition of
 * "today", and the calendar arithmetic the check-in streak is computed from.
 *
 * WHY THIS IS A SEPARATE, PURE MODULE. Everything here is a total function of
 * (instant, timezone) — no database, no clock reads of its own, no Nest
 * injection. That makes the one rule the whole anti-farming story rests on
 * ("the server owns the daily boundary", mobile `docs/rewards-domain-contract.md`
 * §4) directly testable at every awkward boundary — midnight, DST-shifting
 * zones, month and year ends — without booting a module or touching Postgres.
 * `RewardsService` reads the clock once and passes the instant in; it never
 * re-derives a date itself.
 *
 * WHY A `YYYY-MM-DD` STRING RATHER THAN A `Date`. A reward day is a CALENDAR
 * DATE in one pinned zone, not an instant. Storing an instant would force
 * every comparison to re-apply a timezone and re-introduce exactly the
 * ambiguity this module exists to remove — and `2026-08-22` in Asia/Jakarta
 * is a different 24 hours from `2026-08-22` in UTC, so a `Date` column would
 * silently mean different things depending on which code path last touched
 * it. The string is also what goes into the ledger's `idempotencyKey`, where
 * it does the real anti-double-claim work (see `RewardsService.checkIn`).
 */

/** A calendar date in the service timezone, formatted `YYYY-MM-DD`. */
export type RewardPeriodKey = string;

const PERIOD_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The service-timezone calendar date containing `instant`.
 *
 * Uses `en-CA`, whose short date format is ISO-8601 (`2026-08-22`) — chosen
 * over hand-rolling the arithmetic from `getTimezoneOffset` because `Intl`
 * carries the full IANA database, including historical and future DST rules,
 * and is therefore correct for zones this code will never be tested against.
 * `formatToParts` is used rather than `format` so the result cannot be
 * reshaped by a locale that decides to add an era or a different separator.
 *
 * Throws `RangeError` for an invalid timezone. That is deliberate and is why
 * `env.validation.ts` validates `REWARDS_TIMEZONE` at BOOT: a typo must fail
 * the process on startup, not the first user's check-in at runtime.
 */
export function toPeriodKey(instant: Date, timeZone: string): RewardPeriodKey {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const lookup = (type: 'year' | 'month' | 'day'): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  return `${lookup('year')}-${lookup('month')}-${lookup('day')}`;
}

/**
 * The calendar date immediately before `periodKey`.
 *
 * Computed by treating the key as UTC midnight and subtracting exactly 24
 * hours. This is safe precisely BECAUSE the input is already a
 * zone-independent calendar date rather than an instant: no DST transition
 * can occur inside a UTC day, so "the previous calendar date" is pure string
 * arithmetic and never lands on a 23- or 25-hour day. Doing the same
 * subtraction on a real instant in a DST-observing zone is the classic bug
 * this avoids — subtracting 24h from local midnight can land on the same
 * calendar date, silently making a streak day repeatable.
 */
export function previousPeriodKey(periodKey: RewardPeriodKey): RewardPeriodKey {
  assertPeriodKey(periodKey);
  const previous = new Date(
    Date.parse(`${periodKey}T00:00:00.000Z`) - MS_PER_DAY,
  );
  return previous.toISOString().slice(0, 10);
}

/**
 * How a check-in on `today` relates to the account's `lastCheckInDate`.
 *
 * - `already-claimed` — same calendar date; the check-in is a no-op replay.
 * - `continues`       — exactly the previous date; the streak increments.
 * - `restarts`        — never checked in, or any gap at all; streak resets to 1.
 *
 * A gap is NEVER silently repaired (mobile contract §4, "Streak handling":
 * "a missed day must not be silently repairable by a client request").
 * Restoring a broken streak would need its own reason code and its own
 * transaction, which this slice does not offer.
 */
export type CheckInTransition = 'already-claimed' | 'continues' | 'restarts';

export function resolveCheckInTransition(
  lastCheckInDate: RewardPeriodKey | null,
  today: RewardPeriodKey,
): CheckInTransition {
  if (lastCheckInDate === null) {
    return 'restarts';
  }
  if (lastCheckInDate === today) {
    return 'already-claimed';
  }
  return lastCheckInDate === previousPeriodKey(today)
    ? 'continues'
    : 'restarts';
}

/**
 * The streak value a check-in on `today` produces.
 *
 * `already-claimed` returns the streak unchanged — the caller does not write
 * a ledger entry in that case, so this is only ever used to render state.
 *
 * NOTE ON A CLOCK MOVING BACKWARDS: if `lastCheckInDate` is somehow in the
 * FUTURE relative to `today` (an operator corrected the server clock, or the
 * service timezone was repointed westward), `resolveCheckInTransition`
 * classifies it `restarts` rather than `continues`. That is the conservative
 * outcome — it resets a streak instead of paying an unearned day — and the
 * unique ledger key still prevents any double payment for a date that was
 * already claimed.
 */
export function nextStreakDays(
  transition: CheckInTransition,
  currentStreakDays: number,
): number {
  switch (transition) {
    case 'already-claimed':
      return currentStreakDays;
    case 'continues':
      return currentStreakDays + 1;
    case 'restarts':
      return 1;
  }
}

/**
 * The 1-based position in the repeating reward cycle that a streak of
 * `streakDays` occupies — i.e. which entry of `CHECK_IN_REWARD_CURVE` that
 * day pays.
 *
 * A streak of 1 is day 1; a streak of 7 is day 7; a streak of 8 wraps to day
 * 1 of the next cycle. Guards `streakDays <= 0` to 1 so a corrupted or
 * zeroed streak row can never index the curve out of bounds and pay
 * `undefined` points.
 */
export function cycleDayForStreak(streakDays: number): number {
  if (streakDays <= 0) {
    return 1;
  }
  return ((streakDays - 1) % CHECK_IN_CYCLE_LENGTH) + 1;
}

/**
 * The UTC instant at which `periodKey` BEGINS in `timeZone` — i.e. local
 * midnight, expressed as a real point in time.
 *
 * WHY THIS IS NOT `new Date(`${periodKey}T00:00:00Z`)`. That is midnight UTC,
 * which in Asia/Jakarta (UTC+7) is 07:00 local — seven hours after the reward
 * day actually rolled over. Clients render a "resets in HH:MM" countdown from
 * this value, so getting it wrong by a fixed offset is immediately visible and
 * makes the server look like it disagrees with its own daily boundary.
 *
 * THE TWO-PASS OFFSET RESOLUTION. There is no standard API for "what instant
 * is local midnight in zone Z", so this inverts `Intl`: guess that the instant
 * is midnight UTC, measure the zone's offset AT that guess, and subtract it.
 * The second pass exists for DST: if the first guess lands on the other side
 * of a transition, the offset measured there is the wrong one, so the offset
 * is re-measured at the corrected instant and applied again if it changed.
 * Asia/Jakarta has no DST and settles in one pass — the second exists so a
 * deployment that repoints `REWARDS_TIMEZONE` at a DST-observing zone does not
 * silently drift by an hour twice a year.
 */
export function zonedStartOfDayUtc(
  periodKey: RewardPeriodKey,
  timeZone: string,
): Date {
  assertPeriodKey(periodKey);
  const wallClockAsUtc = Date.parse(`${periodKey}T00:00:00.000Z`);

  const firstOffset = zoneOffsetMs(new Date(wallClockAsUtc), timeZone);
  const firstPass = new Date(wallClockAsUtc - firstOffset);

  const secondOffset = zoneOffsetMs(firstPass, timeZone);
  return secondOffset === firstOffset
    ? firstPass
    : new Date(wallClockAsUtc - secondOffset);
}

/**
 * The UTC instant at which the day AFTER `periodKey` begins — the moment the
 * current reward day expires and a new check-in becomes available.
 */
export function nextPeriodStartUtc(
  periodKey: RewardPeriodKey,
  timeZone: string,
): Date {
  return zonedStartOfDayUtc(nextPeriodKey(periodKey), timeZone);
}

/** The calendar date immediately after `periodKey`. */
export function nextPeriodKey(periodKey: RewardPeriodKey): RewardPeriodKey {
  assertPeriodKey(periodKey);
  const next = new Date(Date.parse(`${periodKey}T00:00:00.000Z`) + MS_PER_DAY);
  return next.toISOString().slice(0, 10);
}

/**
 * How far `timeZone` is ahead of UTC at `instant`, in milliseconds.
 *
 * Measured by formatting the instant as wall-clock time in the zone and
 * differencing it against the same fields read in UTC, rather than by parsing
 * a `longOffset` name — offset NAMES are locale-dependent and some zones
 * report values `Date.parse` cannot consume, whereas the numeric fields are
 * stable across every locale and every zone.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const field = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  // `hour: '2-digit'` with `hour12: false` renders midnight as `24` in some
  // ICU versions; normalising it to 0 keeps the arithmetic correct without
  // depending on which convention the runtime picked.
  const hour = field('hour') % 24;

  const asUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    hour,
    field('minute'),
    field('second'),
  );

  // Both sides are whole seconds, so the millisecond component of `instant`
  // must be dropped before differencing or the offset picks up a sub-second
  // remainder that is not part of any real timezone rule.
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

function assertPeriodKey(periodKey: string): void {
  if (!PERIOD_KEY_PATTERN.test(periodKey)) {
    // A malformed key means stored state is corrupt or a caller bypassed
    // `toPeriodKey`. Failing loudly is correct: silently coercing it would
    // produce an `Invalid Date` and, downstream, a streak that never breaks.
    throw new RangeError(`Invalid reward period key: ${periodKey}`);
  }
}
