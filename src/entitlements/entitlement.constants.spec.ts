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
