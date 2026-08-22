import {
  VIDEO_PLAYBACK_URL_RATE_LIMIT,
  VIDEO_PLAYBACK_URL_RATE_TTL_MS,
  VIDEO_STREAM_RATE_LIMIT,
  VIDEO_STREAM_RATE_TTL_MS,
} from '../common/rate-limit.constants';
import { VideosController } from './videos.controller';

/**
 * Work unit "ANONYMOUS FREE-EPISODE PLAYBACK", fix cycle 1 (Reviewer A,
 * MEDIUM finding: `/videos/:id/stream` became anonymous-reachable while
 * still inheriting the generous 300/min app-wide default, unlike
 * `/videos/:id/playback` which had already been given a dedicated ceiling).
 *
 * Asserts the `@Throttle` metadata DIRECTLY rather than by firing hundreds
 * of real requests at a booted app: a behavioral test would have to send
 * 120+ requests to observe the ceiling, would be slow, and — because
 * `ThrottlerGuard` keys on client IP and this repo's e2e suites share one
 * in-process server — would leak its consumed budget into every other test
 * in the file. Reading the metadata proves the exact property that matters
 * (the decorator is present, on the right handler, with the right named
 * throttler and the right numbers) deterministically and in microseconds.
 *
 * The `default` suffix on the metadata keys is not incidental: it is the
 * name of the single throttler registered in `AppModule`, and an override
 * registered under any other name would silently not apply. Pinning the
 * full key is what makes this test able to catch that mistake.
 */
/**
 * `@nestjs/throttler` writes its per-route override as `<PREFIX><throttler
 * name>` metadata on the handler function. These prefixes live in the
 * package's `dist/throttler.constants` module, which is NOT re-exported from
 * its public entry point — importing them from the deep path would couple
 * this test to the package's internal file layout, so they are restated here
 * as literals instead. `assertKeyExists` below is what keeps that safe: if a
 * future throttler version renames a key, the test fails loudly rather than
 * silently comparing `undefined` to `undefined`.
 */
const THROTTLER_LIMIT_PREFIX = 'THROTTLER:LIMIT';
const THROTTLER_TTL_PREFIX = 'THROTTLER:TTL';
/** The single throttler registered in `AppModule.ThrottlerModule.forRoot`. */
const THROTTLER_NAME = 'default';

describe('VideosController rate-limit overrides', () => {
  function readThrottle(methodName: keyof VideosController): {
    limit: unknown;
    ttl: unknown;
  } {
    const handler = VideosController.prototype[methodName];
    const limitKey = `${THROTTLER_LIMIT_PREFIX}${THROTTLER_NAME}`;
    const ttlKey = `${THROTTLER_TTL_PREFIX}${THROTTLER_NAME}`;
    const presentKeys = Reflect.getMetadataKeys(handler) as string[];

    // Guards against this whole file quietly degrading into a no-op if
    // `@nestjs/throttler` ever renames its metadata keys.
    expect(presentKeys).toContain(limitKey);
    expect(presentKeys).toContain(ttlKey);

    return {
      limit: Reflect.getMetadata(limitKey, handler),
      ttl: Reflect.getMetadata(ttlKey, handler),
    };
  }

  it('GET /videos/:id/stream carries the dedicated streaming ceiling, not the app-wide default', () => {
    expect(readThrottle('streamVideo')).toEqual({
      limit: VIDEO_STREAM_RATE_LIMIT,
      ttl: VIDEO_STREAM_RATE_TTL_MS,
    });
  });

  it('GET /videos/:id/playback keeps its pre-existing URL-minting ceiling', () => {
    expect(readThrottle('getPlaybackUrl')).toEqual({
      limit: VIDEO_PLAYBACK_URL_RATE_LIMIT,
      ttl: VIDEO_PLAYBACK_URL_RATE_TTL_MS,
    });
  });

  /**
   * Both optional-auth routes must be bounded. `getFeed`/`getById` are
   * deliberately NOT asserted here — they were already fully public before
   * this work unit and their (unchanged) reliance on the app-wide default is
   * a pre-existing decision this change did not touch.
   */
  it('every anonymous-reachable playback route has an explicit ceiling — none is left on the 300/min default', () => {
    for (const method of ['streamVideo', 'getPlaybackUrl'] as const) {
      const { limit, ttl } = readThrottle(method);
      expect(typeof limit).toBe('number');
      expect(typeof ttl).toBe('number');
      // Strictly tighter than DEFAULT_THROTTLE_LIMIT (300): an override that
      // silently matched or exceeded the default would be pointless.
      expect(limit as number).toBeLessThan(300);
    }
  });
});
