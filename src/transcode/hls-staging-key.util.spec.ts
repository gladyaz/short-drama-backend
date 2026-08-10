import {
  buildHlsHomePrefix,
  buildHlsMasterPlaylistKey,
  buildHlsStagingPrefix,
  deriveActiveGenerationPrefix,
  groupKeysByGenerationPrefix,
} from './hls-staging-key.util';

describe('hls-staging-key.util', () => {
  describe('buildHlsHomePrefix', () => {
    it('returns the fixed hls/ sub-namespace for a media id', () => {
      expect(buildHlsHomePrefix('media-abc')).toBe(
        'admin-media/media-abc/hls/',
      );
    });
  });

  describe('buildHlsStagingPrefix', () => {
    it('builds a versioned, attempt-numbered, uuid-suffixed prefix', () => {
      expect(buildHlsStagingPrefix('media-abc', 3, 1, 'uuid-1234')).toBe(
        'admin-media/media-abc/hls/v3-a1-uuid-1234/',
      );
    });

    // Proof 6: retry gets a fresh immutable prefix — different attempt or
    // different uuid always produces a different prefix.
    it('a different attempt number produces a different prefix', () => {
      const first = buildHlsStagingPrefix('media-abc', 3, 1, 'uuid-1234');
      const second = buildHlsStagingPrefix('media-abc', 3, 2, 'uuid-5678');

      expect(first).not.toBe(second);
    });

    it('a different uuid alone (same version/attempt) still produces a different prefix', () => {
      const first = buildHlsStagingPrefix('media-abc', 3, 1, 'uuid-aaaa');
      const second = buildHlsStagingPrefix('media-abc', 3, 1, 'uuid-bbbb');

      expect(first).not.toBe(second);
    });
  });

  describe('buildHlsMasterPlaylistKey', () => {
    it('appends master.m3u8 to a staging prefix', () => {
      expect(
        buildHlsMasterPlaylistKey('admin-media/media-abc/hls/v3-a1-uuid/'),
      ).toBe('admin-media/media-abc/hls/v3-a1-uuid/master.m3u8');
    });
  });

  describe('deriveActiveGenerationPrefix', () => {
    it('derives the owning generation prefix from a full hlsMasterKey', () => {
      expect(
        deriveActiveGenerationPrefix(
          'admin-media/media-abc/hls/v3-a1-uuid/master.m3u8',
        ),
      ).toBe('admin-media/media-abc/hls/v3-a1-uuid/');
    });

    it('returns null for a null input', () => {
      expect(deriveActiveGenerationPrefix(null)).toBeNull();
    });

    it('returns null for an undefined input', () => {
      expect(deriveActiveGenerationPrefix(undefined)).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(deriveActiveGenerationPrefix('')).toBeNull();
    });

    it('returns null for a malformed key with no slash', () => {
      expect(deriveActiveGenerationPrefix('master.m3u8')).toBeNull();
    });
  });

  describe('groupKeysByGenerationPrefix', () => {
    const homePrefix = 'admin-media/media-abc/hls/';

    it('groups keys by their immediate generation prefix', () => {
      const keys = [
        `${homePrefix}v1-a1-uuid-a/master.m3u8`,
        `${homePrefix}v1-a1-uuid-a/360p/index.m3u8`,
        `${homePrefix}v2-a1-uuid-b/master.m3u8`,
      ];

      const groups = groupKeysByGenerationPrefix(homePrefix, keys);

      expect(groups.size).toBe(2);
      expect(groups.get(`${homePrefix}v1-a1-uuid-a/`)).toEqual([
        `${homePrefix}v1-a1-uuid-a/master.m3u8`,
        `${homePrefix}v1-a1-uuid-a/360p/index.m3u8`,
      ]);
      expect(groups.get(`${homePrefix}v2-a1-uuid-b/`)).toEqual([
        `${homePrefix}v2-a1-uuid-b/master.m3u8`,
      ]);
    });

    it('ignores keys outside the home prefix', () => {
      const keys = [
        'admin-media/media-abc/source',
        `${homePrefix}v1-a1-uuid/master.m3u8`,
      ];

      const groups = groupKeysByGenerationPrefix(homePrefix, keys);

      expect(groups.size).toBe(1);
    });

    it('ignores a key with nothing after the home prefix (no generation segment)', () => {
      const keys = [homePrefix.slice(0, -1)]; // exactly the home prefix, no trailing content

      const groups = groupKeysByGenerationPrefix(homePrefix, keys);

      expect(groups.size).toBe(0);
    });

    it('returns an empty map for an empty key list', () => {
      expect(groupKeysByGenerationPrefix(homePrefix, []).size).toBe(0);
    });
  });
});
