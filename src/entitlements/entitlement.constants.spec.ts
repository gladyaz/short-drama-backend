import { deriveAccessTier, FREE_EPISODE_LIMIT } from './entitlement.constants';

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
