import { DEFAULT_CONTENT_ACCESS_MODE } from '../config/configuration';
import {
  deriveAccessTier,
  FREE_EPISODE_LIMIT,
  resolveAccessTier,
} from './entitlement.constants';

/**
 * Phase 11, work unit 11F-4: pure-function coverage for `deriveAccessTier`,
 * the free/premium tier label used by the backfill migration, `prisma/
 * seed.ts`, and `AdminMediaService.createUpload` to give every `Video` row
 * an explicit `accessTierOverride` at write time. No Nest DI / database
 * needed — this mirrors `EntitlementsService.isEpisodePremium`'s existing
 * boundary exactly (`episodeNumber > freeEpisodeLimit`), just expressed as a
 * `'free' | 'premium'` label instead of a boolean.
 */
describe('deriveAccessTier', () => {
  it('returns "free" for an episodeNumber below the free limit', () => {
    expect(deriveAccessTier(1, 5)).toBe('free');
  });

  it('returns "free" for an episodeNumber exactly AT the free limit (boundary is inclusive of free)', () => {
    expect(deriveAccessTier(5, 5)).toBe('free');
  });

  it('returns "premium" for an episodeNumber one above the free limit', () => {
    expect(deriveAccessTier(6, 5)).toBe('premium');
  });

  it('returns "premium" for an episodeNumber well above the free limit', () => {
    expect(deriveAccessTier(42, 5)).toBe('premium');
  });

  it('defaults to the real FREE_EPISODE_LIMIT constant when no limit argument is passed', () => {
    expect(deriveAccessTier(FREE_EPISODE_LIMIT)).toBe('free');
    expect(deriveAccessTier(FREE_EPISODE_LIMIT + 1)).toBe('premium');
  });

  it('agrees with a hand-derived boolean for every episode number 1-10 (no drift from the isEpisodePremium boundary)', () => {
    for (let episodeNumber = 1; episodeNumber <= 10; episodeNumber += 1) {
      const expected = episodeNumber > 5 ? 'premium' : 'free';
      expect(deriveAccessTier(episodeNumber, 5)).toBe(expected);
    }
  });
});

/**
 * Work unit "Episode Access-Tier + Category Contract Hardening": the ONE
 * authoritative override-vs-default resolver — `EntitlementsService
 * .resolveEpisodePremium`, `PublicSeriesService`'s `hasPremiumEpisodes`
 * aggregate, and `VideoResponseDto.accessTier` all delegate here.
 */
describe('resolveAccessTier', () => {
  it('no override (null), early episode: falls back to the default rule (free)', () => {
    expect(
      resolveAccessTier(
        { accessTierOverride: null, episodeNumber: 1 },
        FREE_EPISODE_LIMIT,
      ),
    ).toBe('free');
  });

  it('no override (undefined), late episode: falls back to the default rule (premium)', () => {
    expect(
      resolveAccessTier(
        { accessTierOverride: undefined, episodeNumber: 6 },
        FREE_EPISODE_LIMIT,
      ),
    ).toBe('premium');
  });

  it('explicit "free" beats a default-premium episode', () => {
    expect(
      resolveAccessTier(
        { accessTierOverride: 'free', episodeNumber: 6 },
        FREE_EPISODE_LIMIT,
      ),
    ).toBe('free');
  });

  it('explicit "premium" beats a default-free episode', () => {
    expect(
      resolveAccessTier(
        { accessTierOverride: 'premium', episodeNumber: 1 },
        FREE_EPISODE_LIMIT,
      ),
    ).toBe('premium');
  });

  it('clearing the override (back to null) restores the default for both a late and an early episode', () => {
    expect(
      resolveAccessTier(
        { accessTierOverride: null, episodeNumber: 6 },
        FREE_EPISODE_LIMIT,
      ),
    ).toBe(deriveAccessTier(6, FREE_EPISODE_LIMIT));
    expect(
      resolveAccessTier(
        { accessTierOverride: null, episodeNumber: 1 },
        FREE_EPISODE_LIMIT,
      ),
    ).toBe(deriveAccessTier(1, FREE_EPISODE_LIMIT));
  });

  it('agrees with deriveAccessTier for every episode number 1-10 when there is no override', () => {
    for (let episodeNumber = 1; episodeNumber <= 10; episodeNumber += 1) {
      expect(
        resolveAccessTier(
          { accessTierOverride: null, episodeNumber },
          FREE_EPISODE_LIMIT,
        ),
      ).toBe(deriveAccessTier(episodeNumber, FREE_EPISODE_LIMIT));
    }
  });
});

/**
 * Work unit "V1 FREE ACCESS POLICY": the precedence matrix for the
 * `accessMode` parameter. `resolveAccessTier` is the ONE function the
 * playback gate, the public `accessTier` DTO field, `requiresAuthHeader`
 * and `hasPremiumEpisodes` all resolve through, so proving the matrix here
 * proves it for all four at once.
 */
describe('resolveAccessTier — CONTENT_ACCESS_MODE precedence', () => {
  const EVERY_OVERRIDE: readonly (string | null | undefined)[] = [
    null,
    undefined,
    'free',
    'premium',
  ];

  describe('entitlement mode (the default) — unchanged behavior', () => {
    it('omitting accessMode entirely is identical to passing "entitlement" explicitly, for every override x episode combination', () => {
      for (const accessTierOverride of EVERY_OVERRIDE) {
        for (let episodeNumber = 1; episodeNumber <= 10; episodeNumber += 1) {
          const omitted = resolveAccessTier(
            { accessTierOverride, episodeNumber },
            FREE_EPISODE_LIMIT,
          );
          const explicit = resolveAccessTier(
            { accessTierOverride, episodeNumber },
            FREE_EPISODE_LIMIT,
            'entitlement',
          );

          expect(omitted).toBe(explicit);
        }
      }
    });

    it('the shipped DEFAULT mode is "entitlement" — the paywall is what a deployment inherits without opting in', () => {
      expect(DEFAULT_CONTENT_ACCESS_MODE).toBe('entitlement');
    });

    it('an explicit "premium" override still wins in entitlement mode', () => {
      expect(
        resolveAccessTier(
          { accessTierOverride: 'premium', episodeNumber: 1 },
          FREE_EPISODE_LIMIT,
          'entitlement',
        ),
      ).toBe('premium');
    });

    it('a late episode with no override still derives premium in entitlement mode', () => {
      expect(
        resolveAccessTier(
          { accessTierOverride: null, episodeNumber: 6 },
          FREE_EPISODE_LIMIT,
          'entitlement',
        ),
      ).toBe('premium');
    });
  });

  describe('free mode — PRECEDENCE POLICY A: the mode outranks every per-row override', () => {
    it('resolves "free" for EVERY override x episode combination, including an explicit "premium" override', () => {
      for (const accessTierOverride of EVERY_OVERRIDE) {
        for (let episodeNumber = 1; episodeNumber <= 10; episodeNumber += 1) {
          expect(
            resolveAccessTier(
              { accessTierOverride, episodeNumber },
              FREE_EPISODE_LIMIT,
              'free',
            ),
          ).toBe('free');
        }
      }
    });

    /**
     * The exact production shape of the V1 dead-end: `series-101` episodes
     * 6-10 each carry an explicit `accessTierOverride: 'premium'` from the
     * 11F-4 backfill, so a policy in which the per-row override outranked
     * the mode would have left every one of them unreachable in a build
     * that ships no purchase flow.
     */
    it('an explicit "premium" override on a late episode — the exact series-101 ep6-10 shape — resolves free', () => {
      expect(
        resolveAccessTier(
          { accessTierOverride: 'premium', episodeNumber: 6 },
          FREE_EPISODE_LIMIT,
          'free',
        ),
      ).toBe('free');
    });

    it('an episode number far beyond any plausible free limit still resolves free', () => {
      expect(
        resolveAccessTier(
          { accessTierOverride: 'premium', episodeNumber: 9999 },
          FREE_EPISODE_LIMIT,
          'free',
        ),
      ).toBe('free');
    });

    it('the free limit argument is irrelevant in free mode — even a limit of 0 yields free', () => {
      expect(
        resolveAccessTier(
          { accessTierOverride: null, episodeNumber: 10 },
          0,
          'free',
        ),
      ).toBe('free');
    });
  });

  describe('reversibility', () => {
    it('switching the mode back to "entitlement" restores the exact tier the same input produced before, with no data change', () => {
      const input = { accessTierOverride: 'premium', episodeNumber: 6 };

      const before = resolveAccessTier(input, FREE_EPISODE_LIMIT);
      const during = resolveAccessTier(input, FREE_EPISODE_LIMIT, 'free');
      const after = resolveAccessTier(input, FREE_EPISODE_LIMIT, 'entitlement');

      expect(before).toBe('premium');
      expect(during).toBe('free');
      expect(after).toBe(before);
      // The input object itself was never mutated by any of the three calls.
      expect(input).toEqual({
        accessTierOverride: 'premium',
        episodeNumber: 6,
      });
    });
  });
});
