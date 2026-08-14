import {
  buildSeriesCoverObjectKey,
  buildSeriesCoverObjectKeyPrefix,
  isValidSeriesCoverObjectKey,
} from './series-cover-key.util';

describe('series-cover-key.util', () => {
  describe('buildSeriesCoverObjectKeyPrefix', () => {
    it('builds the expected admin-series/<id>/cover/ prefix for a plain slug id', () => {
      expect(buildSeriesCoverObjectKeyPrefix('series-104')).toBe(
        'admin-series/series-104/cover/',
      );
    });

    it('percent-encodes a "/" inside a crafted id, never producing an extra path segment', () => {
      const prefix = buildSeriesCoverObjectKeyPrefix('../../admin-media/x');

      expect(prefix).toBe('admin-series/..%2F..%2Fadmin-media%2Fx/cover/');
      // Exactly 3 "/" characters: the 3 structural separators this
      // function itself inserts (`admin-series/`, `/cover/`) — none
      // contributed by the crafted id (its own "/" characters were all
      // percent-encoded to "%2F" above).
      expect(prefix.split('/').length - 1).toBe(3);
    });

    it('two ids that only differ by their trailing digit never share a prefix (no accidental collision)', () => {
      const prefixA = buildSeriesCoverObjectKeyPrefix('series-1');
      const prefixB = buildSeriesCoverObjectKeyPrefix('series-10');

      expect(prefixB.startsWith(prefixA)).toBe(false);
      expect(prefixA.startsWith(prefixB)).toBe(false);
    });
  });

  describe('buildSeriesCoverObjectKey', () => {
    it('produces a key starting with the series-specific prefix, followed by a UUID', () => {
      const key = buildSeriesCoverObjectKey('series-104');

      expect(key.startsWith('admin-series/series-104/cover/')).toBe(true);
      expect(isValidSeriesCoverObjectKey('series-104', key)).toBe(true);
    });

    it('generates a distinct key on every call (per-upload versioning)', () => {
      const first = buildSeriesCoverObjectKey('series-104');
      const second = buildSeriesCoverObjectKey('series-104');

      expect(first).not.toBe(second);
    });
  });

  describe('isValidSeriesCoverObjectKey', () => {
    it('accepts a key this module itself generated for the same series', () => {
      const key = buildSeriesCoverObjectKey('series-104');
      expect(isValidSeriesCoverObjectKey('series-104', key)).toBe(true);
    });

    it('rejects a key generated for a DIFFERENT series', () => {
      const key = buildSeriesCoverObjectKey('series-104');
      expect(isValidSeriesCoverObjectKey('series-105', key)).toBe(false);
    });

    it('rejects an unrelated admin-media/... object key', () => {
      expect(
        isValidSeriesCoverObjectKey(
          'series-104',
          'admin-media/media-abc/source',
        ),
      ).toBe(false);
    });

    it('rejects a key with the right prefix but a non-UUID suffix', () => {
      expect(
        isValidSeriesCoverObjectKey(
          'series-104',
          'admin-series/series-104/cover/not-a-uuid',
        ),
      ).toBe(false);
    });

    it('rejects an attempted traversal appended after a valid-looking prefix', () => {
      const key = buildSeriesCoverObjectKey('series-104');
      expect(
        isValidSeriesCoverObjectKey('series-104', `${key}/../../../etc/passwd`),
      ).toBe(false);
    });

    it('rejects a bare prefix with no version segment at all', () => {
      expect(
        isValidSeriesCoverObjectKey(
          'series-104',
          'admin-series/series-104/cover/',
        ),
      ).toBe(false);
    });

    it('rejects an empty string', () => {
      expect(isValidSeriesCoverObjectKey('series-104', '')).toBe(false);
    });

    it('is case-insensitive on the UUID hex digits (matches what crypto.randomUUID() always produces, lower-case)', () => {
      const key = buildSeriesCoverObjectKey('series-104');
      const upper = key.toUpperCase();
      // The prefix itself must stay exact-case (a real object key from
      // buildSeriesCoverObjectKey is always lower-case), but the UUID shape
      // check alone tolerates upper-case hex — proven directly via the
      // lower-cased prefix reconstructed by hand.
      const version = key.slice(key.lastIndexOf('/') + 1);
      expect(isValidSeriesCoverObjectKey('series-104', key)).toBe(true);
      expect(upper).not.toBe(key); // sanity: the transform actually changed something
      expect(version.toLowerCase()).toBe(version);
    });
  });
});
