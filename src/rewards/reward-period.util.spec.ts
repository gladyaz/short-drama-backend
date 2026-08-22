import {
  cycleDayForStreak,
  nextPeriodKey,
  nextPeriodStartUtc,
  nextStreakDays,
  previousPeriodKey,
  resolveCheckInTransition,
  toPeriodKey,
  zonedStartOfDayUtc,
} from './reward-period.util';
import { CHECK_IN_CYCLE_LENGTH } from './rewards.constants';

/**
 * Pure unit spec (no database, no Nest module) for the module that defines
 * the server's daily boundary.
 *
 * WHY THIS FILE MATTERS MORE THAN ITS SIZE SUGGESTS. Every anti-farming
 * guarantee in the rewards domain reduces to one claim: the server, not the
 * device, decides what day it is, and it decides consistently. If
 * `toPeriodKey` is off by an hour at the boundary, a user can claim twice in
 * one evening. If `previousPeriodKey` mis-steps across a DST transition, a
 * streak either breaks for a user who did nothing wrong or continues for one
 * who skipped a day. Neither failure is visible in an end-to-end test run at
 * 3pm on a Tuesday, which is exactly why these cases are pinned here.
 */
describe('reward-period.util', () => {
  const JAKARTA = 'Asia/Jakarta';

  describe('toPeriodKey', () => {
    it('returns the calendar date in the service timezone, not in UTC', () => {
      // 2026-08-22T17:00Z is 2026-08-23T00:00 in Jakarta (UTC+7). A server
      // that answered "2026-08-22" here would hand out a second check-in for
      // a day the user already claimed.
      expect(toPeriodKey(new Date('2026-08-22T17:00:00Z'), JAKARTA)).toBe(
        '2026-08-23',
      );
    });

    it('CRITICAL: the last minute before local midnight is still the old day', () => {
      expect(toPeriodKey(new Date('2026-08-22T16:59:59Z'), JAKARTA)).toBe(
        '2026-08-22',
      );
    });

    it('agrees with UTC when the service timezone is UTC', () => {
      expect(toPeriodKey(new Date('2026-08-22T04:00:00Z'), 'UTC')).toBe(
        '2026-08-22',
      );
    });

    it('handles a zone behind UTC, where local date lags the UTC date', () => {
      // 03:00Z on the 22nd is 23:00 on the 21st in New York.
      expect(
        toPeriodKey(new Date('2026-08-22T03:00:00Z'), 'America/New_York'),
      ).toBe('2026-08-21');
    });

    it('throws for a timezone Intl cannot resolve, rather than silently using UTC', () => {
      expect(() => toPeriodKey(new Date(), 'Asia/Jakata')).toThrow(RangeError);
    });
  });

  describe('previousPeriodKey / nextPeriodKey', () => {
    it('steps across a month boundary', () => {
      expect(previousPeriodKey('2026-09-01')).toBe('2026-08-31');
      expect(nextPeriodKey('2026-08-31')).toBe('2026-09-01');
    });

    it('steps across a year boundary', () => {
      expect(previousPeriodKey('2026-01-01')).toBe('2025-12-31');
      expect(nextPeriodKey('2025-12-31')).toBe('2026-01-01');
    });

    it('handles leap and non-leap Februaries', () => {
      expect(nextPeriodKey('2028-02-28')).toBe('2028-02-29');
      expect(nextPeriodKey('2026-02-28')).toBe('2026-03-01');
      expect(previousPeriodKey('2028-03-01')).toBe('2028-02-29');
    });

    it('rejects a malformed key instead of producing an Invalid Date', () => {
      // A silently-coerced bad key would yield NaN arithmetic and a streak
      // that never breaks — a free-money bug that looks like a date bug.
      expect(() => previousPeriodKey('not-a-date')).toThrow(RangeError);
      expect(() => previousPeriodKey('2026-8-1')).toThrow(RangeError);
    });
  });

  describe('zonedStartOfDayUtc', () => {
    it('resolves local midnight, not midnight UTC', () => {
      expect(zonedStartOfDayUtc('2026-08-23', JAKARTA).toISOString()).toBe(
        '2026-08-22T17:00:00.000Z',
      );
    });

    it('round-trips: the instant it returns belongs to the day it was asked about', () => {
      for (const key of ['2026-01-01', '2026-06-15', '2026-12-31']) {
        expect(toPeriodKey(zonedStartOfDayUtc(key, JAKARTA), JAKARTA)).toBe(
          key,
        );
      }
    });

    it('CRITICAL: a DST spring-forward day is 23 hours long, not 24', () => {
      // America/New_York loses an hour on 2026-03-08. A fixed +24h step would
      // put the next boundary an hour late, letting the day be claimed twice
      // in the overlap.
      const start = zonedStartOfDayUtc('2026-03-08', 'America/New_York');
      const next = nextPeriodStartUtc('2026-03-08', 'America/New_York');
      expect((next.getTime() - start.getTime()) / 3_600_000).toBe(23);
    });

    it('CRITICAL: a DST fall-back day is 25 hours long', () => {
      const start = zonedStartOfDayUtc('2026-11-01', 'America/New_York');
      const next = nextPeriodStartUtc('2026-11-01', 'America/New_York');
      expect((next.getTime() - start.getTime()) / 3_600_000).toBe(25);
    });

    it('is exactly 24 hours in a zone without DST', () => {
      const start = zonedStartOfDayUtc('2026-03-08', JAKARTA);
      const next = nextPeriodStartUtc('2026-03-08', JAKARTA);
      expect((next.getTime() - start.getTime()) / 3_600_000).toBe(24);
    });
  });

  describe('resolveCheckInTransition', () => {
    it('treats a first-ever check-in as a fresh streak', () => {
      expect(resolveCheckInTransition(null, '2026-08-22')).toBe('restarts');
    });

    it('treats the same date as already claimed', () => {
      expect(resolveCheckInTransition('2026-08-22', '2026-08-22')).toBe(
        'already-claimed',
      );
    });

    it('continues the streak on the immediately following date', () => {
      expect(resolveCheckInTransition('2026-08-21', '2026-08-22')).toBe(
        'continues',
      );
    });

    it('CRITICAL: any gap resets, and is never silently repaired', () => {
      // The mobile domain contract is explicit that a missed day "must not be
      // silently repairable by a client request".
      expect(resolveCheckInTransition('2026-08-20', '2026-08-22')).toBe(
        'restarts',
      );
      expect(resolveCheckInTransition('2026-01-01', '2026-08-22')).toBe(
        'restarts',
      );
    });

    it('CRITICAL: a last-check-in date in the FUTURE resets rather than continuing', () => {
      // Reachable if the server clock is corrected backwards or the service
      // timezone is repointed westward. Resetting loses a streak; the
      // alternative would pay an unearned day.
      expect(resolveCheckInTransition('2026-08-25', '2026-08-22')).toBe(
        'restarts',
      );
    });
  });

  describe('nextStreakDays', () => {
    it('increments on a continued streak', () => {
      expect(nextStreakDays('continues', 3)).toBe(4);
    });

    it('resets to 1 on a restart, regardless of how long the old streak was', () => {
      expect(nextStreakDays('restarts', 40)).toBe(1);
    });

    it('leaves the streak untouched when today was already claimed', () => {
      expect(nextStreakDays('already-claimed', 3)).toBe(3);
    });
  });

  describe('cycleDayForStreak', () => {
    it('maps the first cycle one-to-one', () => {
      for (let streak = 1; streak <= CHECK_IN_CYCLE_LENGTH; streak += 1) {
        expect(cycleDayForStreak(streak)).toBe(streak);
      }
    });

    it('wraps to day 1 at the start of the next cycle', () => {
      expect(cycleDayForStreak(CHECK_IN_CYCLE_LENGTH + 1)).toBe(1);
      expect(cycleDayForStreak(CHECK_IN_CYCLE_LENGTH * 2)).toBe(
        CHECK_IN_CYCLE_LENGTH,
      );
    });

    it('CRITICAL: never returns an out-of-range index for a zero or negative streak', () => {
      // A corrupted streak row must not index the reward curve out of bounds
      // and pay `undefined` points — that lands in the ledger as NaN.
      expect(cycleDayForStreak(0)).toBe(1);
      expect(cycleDayForStreak(-5)).toBe(1);
    });

    it('stays within the curve for every streak up to four cycles', () => {
      for (let streak = 1; streak <= CHECK_IN_CYCLE_LENGTH * 4; streak += 1) {
        const day = cycleDayForStreak(streak);
        expect(day).toBeGreaterThanOrEqual(1);
        expect(day).toBeLessThanOrEqual(CHECK_IN_CYCLE_LENGTH);
      }
    });
  });
});
