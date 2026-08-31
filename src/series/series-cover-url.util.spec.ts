import {
  createPresignedGetUrlMock,
  syntheticSignedGetUrlFor,
} from '../common/testing/storage-mock.helpers';
import { StorageService } from '../storage/storage.service';
import { DEFAULT_GET_URL_EXPIRY_SECONDS } from '../storage/storage.constants';
import {
  buildLocalSeriesCoverUrl,
  resolveSeriesCoverUrl,
} from './series-cover-url.util';

/**
 * Work unit "LOCAL SERIES COVER ARTWORK": the `coverUrl` contract is one
 * shape (`string | null`) served by two mechanisms. These tests pin BOTH,
 * and in particular pin that the `r2` branch did not change.
 */
describe('resolveSeriesCoverUrl', () => {
  const KEY = 'admin-series/series-104/cover/f1a2';

  function buildStorageService(): {
    service: StorageService;
    createPresignedGetUrl: jest.Mock;
  } {
    const createPresignedGetUrl = createPresignedGetUrlMock();

    return {
      service: { createPresignedGetUrl } as unknown as StorageService,
      createPresignedGetUrl,
    };
  }

  it.each(['r2', 'local'] as const)(
    'returns null for a series with no coverImageKey (driver=%s)',
    async (driver) => {
      const { service, createPresignedGetUrl } = buildStorageService();

      const url = await resolveSeriesCoverUrl(
        service,
        { driver, publicBaseUrl: 'http://localhost:3000' },
        { id: 'series-104', coverImageKey: null },
      );

      expect(url).toBeNull();
      // Null is authoritative "no artwork", never a reason to sign anything.
      expect(createPresignedGetUrl).not.toHaveBeenCalled();
    },
  );

  describe('r2 driver', () => {
    it('mints a presigned GET for the key, at the cover expiry', async () => {
      const { service, createPresignedGetUrl } = buildStorageService();

      const url = await resolveSeriesCoverUrl(
        service,
        { driver: 'r2', publicBaseUrl: 'http://localhost:3000' },
        { id: 'series-104', coverImageKey: KEY },
      );

      expect(url).toBe(syntheticSignedGetUrlFor(KEY));
      expect(createPresignedGetUrl).toHaveBeenCalledWith(KEY, {
        expiresInSeconds: DEFAULT_GET_URL_EXPIRY_SECONDS,
      });
    });

    /**
     * Pins the property the mobile app's cover-recovery module depends on: a
     * signing failure is NOT degraded to `coverUrl: null`, because null means
     * "this series has no artwork" and would stop the app retrying.
     */
    it('propagates a signing failure rather than reporting null', async () => {
      const { service, createPresignedGetUrl } = buildStorageService();
      createPresignedGetUrl.mockRejectedValueOnce(new Error('signing failed'));

      await expect(
        resolveSeriesCoverUrl(
          service,
          { driver: 'r2', publicBaseUrl: 'http://localhost:3000' },
          { id: 'series-104', coverImageKey: KEY },
        ),
      ).rejects.toThrow('signing failed');
    });
  });

  describe('local driver', () => {
    it('returns this API’s own cover route, absolute', async () => {
      const { service, createPresignedGetUrl } = buildStorageService();

      const url = await resolveSeriesCoverUrl(
        service,
        { driver: 'local', publicBaseUrl: 'http://localhost:3000' },
        { id: 'series-104', coverImageKey: KEY },
      );

      expect(url).toBe('http://localhost:3000/series/series-104/cover');
      // The local branch must never reach the S3 client: under this driver it
      // is built from empty credentials and would return a plausible-looking
      // URL for a bucket that does not exist.
      expect(createPresignedGetUrl).not.toHaveBeenCalled();
    });

    it('never leaks the object key into the URL', async () => {
      const { service } = buildStorageService();

      const url = await resolveSeriesCoverUrl(
        service,
        { driver: 'local', publicBaseUrl: 'http://localhost:3000' },
        { id: 'series-104', coverImageKey: KEY },
      );

      expect(url).not.toContain('f1a2');
      expect(url).not.toContain('admin-series');
    });
  });
});

describe('buildLocalSeriesCoverUrl', () => {
  it('normalises a base URL given with trailing slashes', () => {
    expect(buildLocalSeriesCoverUrl('http://host:3000///', 'series-104')).toBe(
      'http://host:3000/series/series-104/cover',
    );
  });

  it('works against a LAN origin, which is how a phone reaches this API', () => {
    expect(
      buildLocalSeriesCoverUrl('http://192.168.1.4:3000', 'series-010'),
    ).toBe('http://192.168.1.4:3000/series/series-010/cover');
  });

  /**
   * `Series.id` is client-provided at create time and constrained only by
   * length, so an id carrying URL syntax must be CARRIED by the path, never
   * allowed to restructure it.
   */
  it.each([
    ['a slash', 'a/b', 'http://host/series/a%2Fb/cover'],
    ['a query start', 'a?b', 'http://host/series/a%3Fb/cover'],
    ['a fragment start', 'a#b', 'http://host/series/a%23b/cover'],
    ['a traversal attempt', '../..', 'http://host/series/..%2F../cover'],
  ])('percent-encodes an id containing %s', (_label, id, expected) => {
    expect(buildLocalSeriesCoverUrl('http://host', id)).toBe(expected);
  });
});
