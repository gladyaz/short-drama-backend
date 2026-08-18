import { randomUUID } from 'crypto';
import { buildSeriesCoverObjectKey } from '../series-cover-key.util';
import {
  SERIES_COVER_OBJECT_KEY_ROOT_PREFIX,
  parseSeriesCoverObjectKey,
} from './series-cover-orphan-key.util';

/**
 * Slice "SERIES COVER ORPHAN CLEANUP LIFECYCLE". These are the tests that
 * pin the sweep's NAMESPACE boundary — the property that no `admin-media/`
 * object, no HLS segment, and no hand-crafted lookalike key can ever be
 * classified as a Series cover and become a deletion candidate.
 */
describe('parseSeriesCoverObjectKey', () => {
  describe('accepts exactly what the canonical builder produces', () => {
    it('round-trips a plain slug id built by buildSeriesCoverObjectKey', () => {
      const seriesId = 'series-104';

      const key = buildSeriesCoverObjectKey(seriesId);

      expect(parseSeriesCoverObjectKey(key)).toEqual({ seriesId });
    });

    it('round-trips an id whose characters require percent-encoding', () => {
      // `Series.id` is CLIENT-provided with no format restriction beyond
      // length, so an id containing `/` is reachable — and is exactly the
      // case `encodeURIComponent` collapses into one path-safe segment.
      const seriesId = '../../admin-media/x';

      const key = buildSeriesCoverObjectKey(seriesId);

      expect(key.split('/')).toHaveLength(4);
      expect(parseSeriesCoverObjectKey(key)).toEqual({ seriesId });
    });

    it('round-trips a non-ASCII id', () => {
      const seriesId = 'drama-é-104';

      expect(
        parseSeriesCoverObjectKey(buildSeriesCoverObjectKey(seriesId)),
      ).toEqual({ seriesId });
    });
  });

  describe('rejects anything outside the Series-cover namespace', () => {
    it.each([
      ['a media source object', 'admin-media/video-1/source'],
      ['a media cover object', 'admin-media/video-1/cover'],
      ['an HLS segment', 'admin-media/video-1/hls/v1-a1-uuid/360p/000.ts'],
      [
        'an HLS master playlist',
        'admin-media/video-1/hls/v1-a1-uuid/master.m3u8',
      ],
      ['a thumbnail', 'admin-media/video-1/thumbnail'],
      ['a smoke-test scratch object', '_r2-smoke-tests/11g-4-1-uuid.txt'],
      ['a bare root-level object', 'some-object.bin'],
      ['an empty key', ''],
    ])('rejects %s', (_label, key) => {
      expect(parseSeriesCoverObjectKey(key)).toBeNull();
    });

    it('rejects a key that merely CONTAINS the root prefix later on', () => {
      expect(
        parseSeriesCoverObjectKey(
          `admin-media/x/admin-series/y/cover/${randomUUID()}`,
        ),
      ).toBeNull();
    });
  });

  describe('rejects malformed keys inside the root prefix', () => {
    it('rejects a non-UUID version segment', () => {
      expect(
        parseSeriesCoverObjectKey('admin-series/series-104/cover/not-a-uuid'),
      ).toBeNull();
    });

    it('rejects a missing version segment', () => {
      expect(
        parseSeriesCoverObjectKey('admin-series/series-104/cover/'),
      ).toBeNull();
    });

    it('rejects extra path segments smuggled in after the UUID', () => {
      expect(
        parseSeriesCoverObjectKey(
          `admin-series/series-104/cover/${randomUUID()}/extra`,
        ),
      ).toBeNull();
    });

    it('rejects a wrong middle segment', () => {
      expect(
        parseSeriesCoverObjectKey(
          `admin-series/series-104/poster/${randomUUID()}`,
        ),
      ).toBeNull();
    });

    it('rejects an empty series-id segment', () => {
      expect(
        parseSeriesCoverObjectKey(`admin-series//cover/${randomUUID()}`),
      ).toBeNull();
    });

    it('rejects a malformed percent-escape rather than throwing URIError', () => {
      expect(
        parseSeriesCoverObjectKey(`admin-series/%zz/cover/${randomUUID()}`),
      ).toBeNull();
    });

    it('rejects a NON-CANONICAL encoding that decodeURIComponent alone would accept', () => {
      // `%2f` decodes to `/` exactly as `%2F` does, but the canonical builder
      // only ever emits the uppercase form — so this key could not have been
      // minted by this backend and must not be attributed to series "a/b".
      // This is the case a hand-rolled decode-only parser would get wrong.
      const nonCanonical = `admin-series/a%2fb/cover/${randomUUID()}`;

      expect(parseSeriesCoverObjectKey(nonCanonical)).toBeNull();
    });
  });

  it('exposes a root prefix every freshly built cover key actually starts with', () => {
    // Pins the two halves together: the constant the sweep enumerates under
    // and the keys the upload path mints must not drift apart.
    expect(SERIES_COVER_OBJECT_KEY_ROOT_PREFIX).toBe('admin-series/');
    expect(
      buildSeriesCoverObjectKey('series-104').startsWith(
        SERIES_COVER_OBJECT_KEY_ROOT_PREFIX,
      ),
    ).toBe(true);
  });
});
