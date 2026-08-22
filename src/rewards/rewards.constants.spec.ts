import {
  CHECK_IN_BONUS_DAY,
  CHECK_IN_CYCLE_LENGTH,
  CHECK_IN_REWARD_CURVE,
  DEV_GRANT_MAX_POINTS,
  findRedemptionOffer,
  LEDGER_PAGE_SIZE_DEFAULT,
  LEDGER_PAGE_SIZE_MAX,
  REWARD_REDEMPTION_OFFERS,
  REWARD_TASK_DEFINITIONS,
} from './rewards.constants';

/**
 * Configuration-invariant spec.
 *
 * These assertions are not testing logic — they are testing that the
 * ECONOMICS TABLE cannot be edited into a shape that breaks the code reading
 * it. The reward curve is indexed by cycle day with no bounds check at the
 * call site (`CHECK_IN_REWARD_CURVE[cycleDay - 1]`), so a curve one entry
 * short would pay `undefined` points and write a NaN delta into an
 * append-only ledger. Someone retuning the curve for a product experiment
 * should be stopped here, by a test that explains why, rather than in
 * production by a corrupted balance.
 */
describe('rewards.constants', () => {
  describe('check-in curve', () => {
    it('CRITICAL: has exactly one entry per cycle day', () => {
      expect(CHECK_IN_REWARD_CURVE).toHaveLength(CHECK_IN_CYCLE_LENGTH);
    });

    it('CRITICAL: every entry is a positive integer', () => {
      // A zero would consume the day's idempotency key while paying nothing
      // and would be rejected by the `deltaPoints <> 0` CHECK constraint; a
      // negative would turn a reward into a penalty.
      for (const points of CHECK_IN_REWARD_CURVE) {
        expect(Number.isInteger(points)).toBe(true);
        expect(points).toBeGreaterThan(0);
      }
    });

    it('has a bonus day that exists within the cycle', () => {
      expect(CHECK_IN_BONUS_DAY).toBeGreaterThanOrEqual(1);
      expect(CHECK_IN_BONUS_DAY).toBeLessThanOrEqual(CHECK_IN_CYCLE_LENGTH);
    });

    it('pays the most on the bonus day, so the streak incentive is real', () => {
      const bonus = CHECK_IN_REWARD_CURVE[CHECK_IN_BONUS_DAY - 1];
      for (const points of CHECK_IN_REWARD_CURVE) {
        expect(bonus).toBeGreaterThanOrEqual(points);
      }
    });
  });

  describe('redemption catalog', () => {
    it('CRITICAL: every offer costs a positive integer and grants positive days', () => {
      for (const offer of REWARD_REDEMPTION_OFFERS) {
        expect(Number.isInteger(offer.costPoints)).toBe(true);
        expect(offer.costPoints).toBeGreaterThan(0);
        expect(Number.isInteger(offer.grantsDays)).toBe(true);
        expect(offer.grantsDays).toBeGreaterThan(0);
      }
    });

    it('CRITICAL: offer ids are unique, so a lookup cannot be ambiguous', () => {
      const ids = REWARD_REDEMPTION_OFFERS.map((offer) => offer.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('findRedemptionOffer resolves a known id and returns undefined otherwise', () => {
      expect(findRedemptionOffer('redeem_vip_1d')?.grantsDays).toBe(1);
      expect(findRedemptionOffer('redeem_nonexistent')).toBeUndefined();
    });
  });

  describe('task catalog', () => {
    it('CRITICAL: no task is claimable', () => {
      // The honest position this slice ships (see the catalog's own doc
      // comment and docs/rewards-api-contract.md §6): none of these has a
      // server-verifiable completion signal, so none may be paid. If a future
      // change flips one of these to true, it must arrive WITH a verification
      // path and this assertion must be updated deliberately — not silently.
      for (const task of REWARD_TASK_DEFINITIONS) {
        expect(task.isClaimSupported).toBe(false);
        expect(task.unsupportedReason).toBeDefined();
      }
    });

    it('task ids are unique', () => {
      const ids = REWARD_TASK_DEFINITIONS.map((task) => task.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('every social task names its platform', () => {
      for (const task of REWARD_TASK_DEFINITIONS) {
        if (task.type === 'SOCIAL_FOLLOW') {
          expect(task.socialPlatform).toBeDefined();
        }
      }
    });
  });

  describe('bounds', () => {
    it('ledger page sizes are sane and ordered', () => {
      expect(LEDGER_PAGE_SIZE_DEFAULT).toBeGreaterThan(0);
      expect(LEDGER_PAGE_SIZE_MAX).toBeGreaterThanOrEqual(
        LEDGER_PAGE_SIZE_DEFAULT,
      );
    });

    it('the dev grant ceiling is positive', () => {
      expect(DEV_GRANT_MAX_POINTS).toBeGreaterThan(0);
    });
  });
});
