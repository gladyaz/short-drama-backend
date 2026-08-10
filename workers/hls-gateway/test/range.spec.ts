import { describe, expect, it } from 'vitest';
import { parseRangeHeader } from '../src/range';

describe('parseRangeHeader', () => {
  it('returns null for a missing header (serve full object)', () => {
    expect(parseRangeHeader(null)).toBeNull();
  });

  it('parses a closed range bytes=0-99', () => {
    expect(parseRangeHeader('bytes=0-99')).toEqual({ offset: 0, length: 100 });
  });

  it('parses an open-ended range bytes=500-', () => {
    expect(parseRangeHeader('bytes=500-')).toEqual({ offset: 500 });
  });

  it('parses a suffix range bytes=-500', () => {
    expect(parseRangeHeader('bytes=-500')).toEqual({ suffix: 500 });
  });

  it('returns null for a malformed header (never throws)', () => {
    expect(parseRangeHeader('not-a-range')).toBeNull();
    expect(parseRangeHeader('bytes=')).toBeNull();
    expect(parseRangeHeader('bytes=-')).toBeNull();
  });

  it('returns null when start > end', () => {
    expect(parseRangeHeader('bytes=100-50')).toBeNull();
  });
});
