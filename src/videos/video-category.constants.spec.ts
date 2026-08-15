import {
  isValidVideoCategory,
  VIDEO_CATEGORIES,
} from './video-category.constants';

/**
 * Work unit "Episode Access-Tier + Category Contract Hardening": pure
 * unit coverage for the closed canonical category set — a regression guard
 * against an accidental change to `VIDEO_CATEGORIES` (e.g. adding mobile's
 * broader/differently-cased list, or silently dropping a real value), and
 * direct boundary coverage for the `isValidVideoCategory` guard used by the
 * one write path (`MediaImporterService`) that has no `class-validator` DTO
 * in front of it.
 */
describe('VIDEO_CATEGORIES', () => {
  it('is exactly the four audited canonical values, lowercase', () => {
    expect([...VIDEO_CATEGORIES].sort()).toEqual([
      'action',
      'comedy',
      'drama',
      'romance',
    ]);
  });
});

describe('isValidVideoCategory', () => {
  it.each(VIDEO_CATEGORIES)('accepts the canonical value "%s"', (category) => {
    expect(isValidVideoCategory(category)).toBe(true);
  });

  it('rejects an unrecognised string', () => {
    expect(isValidVideoCategory('thriller')).toBe(false);
  });

  it('rejects a differently-cased variant of a canonical value (case-sensitive)', () => {
    expect(isValidVideoCategory('Drama')).toBe(false);
    expect(isValidVideoCategory('ACTION')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidVideoCategory('')).toBe(false);
  });
});
