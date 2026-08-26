import {
  CHECK_IN_BONUS_DAY,
  CHECK_IN_CYCLE_LENGTH,
  CHECK_IN_REWARD_CURVE,
  DEV_GRANT_MAX_POINTS,
  findRedemptionOffer,
  findWatchMissionDefinition,
  isOfferApplicable,
  LEDGER_PAGE_SIZE_DEFAULT,
  LEDGER_PAGE_SIZE_MAX,
  REWARD_PERK_TYPES,
  REWARD_REDEMPTION_OFFERS,
  REWARD_TASK_DEFINITIONS,
  WATCH_MISSION_DEFINITIONS,
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
    it('CRITICAL: every offer costs a positive integer and never grants negative days', () => {
      for (const offer of REWARD_REDEMPTION_OFFERS) {
        expect(Number.isInteger(offer.costPoints)).toBe(true);
        expect(offer.costPoints).toBeGreaterThan(0);
        expect(Number.isInteger(offer.grantsDays)).toBe(true);
        // Work unit "REWARDS V1 EARN AND SPEND" relaxed this from `> 0`:
        // an AD_PERK offer buys an ad perk and no premium at all, and
        // records 0 days. The invariant that still matters — and that the
        // migration's CHECK now enforces — is that a receipt never claims a
        // NEGATIVE benefit.
        expect(offer.grantsDays).toBeGreaterThanOrEqual(0);
      }
    });

    it('CRITICAL: every offer actually hands something over', () => {
      // The failure this guards against is an offer that debits points and
      // issues nothing — a catalog typo that would be a silent theft.
      for (const offer of REWARD_REDEMPTION_OFFERS) {
        if (offer.kind === 'AD_PERK') {
          expect(offer.perk).toBeDefined();
          expect(offer.perk!.durationMinutes).toBeGreaterThan(0);
          expect(offer.grantsDays).toBe(0);
        } else {
          expect(offer.perk).toBeUndefined();
          expect(offer.grantsDays).toBeGreaterThan(0);
        }
      }
    });

    it('CRITICAL: V1 has at least one purchasable ad perk, so coins have a use', () => {
      // V1 ships free content + ads + rewards and NO paywall. If this list is
      // ever empty, coins buy nothing that a free-mode deployment can deliver.
      const adPerks = REWARD_REDEMPTION_OFFERS.filter(
        (offer) => offer.kind === 'AD_PERK' && offer.isEnabled,
      );

      expect(adPerks.length).toBeGreaterThan(0);
      expect(adPerks.map((offer) => offer.perk!.type)).toContain(
        REWARD_PERK_TYPES.SKIP_NEXT_INTERSTITIAL,
      );
    });

    it('CRITICAL: withholds premium offers where every episode is already free', () => {
      for (const offer of REWARD_REDEMPTION_OFFERS) {
        // Selling "unlock every premium episode" in a deployment with no
        // locked episodes is selling nothing.
        expect(isOfferApplicable(offer, 'free')).toBe(
          offer.kind !== 'PREMIUM_DAYS',
        );
        // Ad perks are applicable in every mode; premium offers return under
        // the entitlement policy.
        expect(isOfferApplicable(offer, 'entitlement')).toBe(true);
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

    it('CRITICAL: no longer carries the social tiles, which are now real missions', () => {
      // Work unit "REWARDS V1 EARN AND SPEND" moved social follows out of
      // this "cannot be paid" list and into a configured, claimable catalog
      // (`SOCIAL_MISSION_DEFINITIONS`). A social id reappearing here would
      // mean a user seeing the same tile twice — once payable, once not.
      for (const task of REWARD_TASK_DEFINITIONS) {
        expect(task.id.startsWith('task_social_')).toBe(false);
      }
    });

    it('CRITICAL: a rewarded ad stays unclaimable while no server callback exists', () => {
      // The single honest statement about ads in this backend: the whole ads
      // surface is `GET /config/ads`, a read-only frequency config with no
      // callback endpoint, no shared secret and no transaction id. Until one
      // exists, crediting "the ad finished" is crediting an untrusted device.
      const rewardedAd = REWARD_TASK_DEFINITIONS.find(
        (task) => task.type === 'REWARDED_AD',
      );

      expect(rewardedAd).toBeDefined();
      expect(rewardedAd!.isClaimSupported).toBe(false);
      expect(rewardedAd!.unsupportedReason).toBe('NO_VERIFIABLE_SIGNAL');
    });
  });

  describe('watch missions', () => {
    it('CRITICAL: every milestone has a positive integer goal and reward', () => {
      for (const mission of WATCH_MISSION_DEFINITIONS) {
        expect(Number.isInteger(mission.requiredEpisodes)).toBe(true);
        expect(mission.requiredEpisodes).toBeGreaterThan(0);
        expect(mission.rewardPoints).toBeGreaterThan(0);
      }
    });

    it('mission ids are unique and resolvable', () => {
      const ids = WATCH_MISSION_DEFINITIONS.map((mission) => mission.id);
      expect(new Set(ids).size).toBe(ids.length);

      for (const mission of WATCH_MISSION_DEFINITIONS) {
        expect(findWatchMissionDefinition(mission.id)).toBe(mission);
      }

      expect(findWatchMissionDefinition('task_watch_nothing')).toBeUndefined();
    });

    it('pays more for the harder milestone, so the ladder is worth climbing', () => {
      const sorted = [...WATCH_MISSION_DEFINITIONS].sort(
        (a, b) => a.requiredEpisodes - b.requiredEpisodes,
      );

      for (let index = 1; index < sorted.length; index += 1) {
        expect(sorted[index].rewardPoints).toBeGreaterThan(
          sorted[index - 1].rewardPoints,
        );
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
