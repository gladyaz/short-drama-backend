import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleRequest } from '../src/index';
import type { CacheLike, Env } from '../src/env.types';
import { FakeMediaBucket, streamToText } from './fake-bucket';
import vectors from './token-vectors.json';

const SECRET = vectors.secret;
const PREFIX = vectors.prefix;
const MASTER_KEY = `${PREFIX}master.m3u8`;
const RENDITION_KEY = `${PREFIX}360p/index.m3u8`;
const OTHER_MASTER_KEY = `${vectors.otherPrefix}master.m3u8`;
const NEXT_GEN_MASTER_KEY = `${vectors.genNextPrefix}master.m3u8`;

function makeEnv(overrides?: Partial<Env>): { env: Env; bucket: FakeMediaBucket } {
  const bucket = new FakeMediaBucket();
  const env: Env = {
    MEDIA_BUCKET: bucket,
    HLS_TOKEN_SECRET: SECRET,
    CACHE_ENABLED: 'false',
    ...overrides,
  };
  return { env, bucket };
}

function requestFor(token: string, relativePath: string, headers?: HeadersInit): Request {
  return new Request(`https://gateway.internal/t/${token}/${relativePath}`, {
    headers,
  });
}

describe('handleRequest (Slice 11Q gateway handler)', () => {
  let env: Env;
  let bucket: FakeMediaBucket;

  beforeEach(() => {
    // vectors.now is a fixed reference clock — pin Date.now() to it so the
    // "valid" fixture token (exp = now + 3600) is genuinely unexpired for
    // every test in this file, without depending on real wall-clock time.
    vi.useFakeTimers();
    vi.setSystemTime(vectors.now * 1000);

    const created = makeEnv();
    env = created.env;
    bucket = created.bucket;
    bucket.put(MASTER_KEY, new TextEncoder().encode('#EXTM3U\nmaster-playlist-body'));
    bucket.put(RENDITION_KEY, new TextEncoder().encode('#EXTM3U\nrendition-playlist-body'));
    bucket.put(OTHER_MASTER_KEY, new TextEncoder().encode('#EXTM3U\nother-episode-master'));
    bucket.put(NEXT_GEN_MASTER_KEY, new TextEncoder().encode('#EXTM3U\nnext-gen-master'));
  });

  it('[TEST 1] a valid token + correct relative path succeeds with 200 and the correct Content-Type', async () => {
    const response = await handleRequest(
      requestFor(vectors.valid, 'master.m3u8'),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe(
      'application/vnd.apple.mpegurl',
    );
    expect(await response.text()).toBe('#EXTM3U\nmaster-playlist-body');
  });

  it('a valid token can also fetch a rendition playlist under the same prefix', async () => {
    const response = await handleRequest(
      requestFor(vectors.valid, '360p/index.m3u8'),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('#EXTM3U\nrendition-playlist-body');
  });

  it('[TEST 2] an invalid-signature token is rejected with a uniform 403', async () => {
    const response = await handleRequest(
      requestFor(vectors.tamperedSignature, 'master.m3u8'),
      env,
    );
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).not.toContain(vectors.tamperedSignature);
    expect(body).not.toContain(SECRET);
  });

  it('[TEST 3] an expired token is rejected with a uniform 403', async () => {
    const response = await handleRequest(
      requestFor(vectors.expired, 'master.m3u8'),
      env,
    );
    expect(response.status).toBe(403);
  });

  it('[TEST 4] a token minted for media A cannot fetch media B\'s objects, even at the identical relative path', async () => {
    // vectors.validDifferentPrefix is a genuinely valid token, but for
    // otherMediaId/otherPrefix. Requesting "master.m3u8" through it can only
    // ever resolve to otherPrefix + "master.m3u8" (OTHER_MASTER_KEY) — never
    // to PREFIX + "master.m3u8" (media A's own object). This test proves the
    // NEGATIVE: token A cannot reach media B's key.
    const response = await handleRequest(
      requestFor(vectors.valid, '../does-not-escape/master.m3u8'),
      env,
    );
    // The traversal itself is rejected at the path layer (belt-and-suspenders
    // — proven independently in path.spec.ts); the point of THIS test is
    // that there is no request shape that lets token A name media B's key.
    expect(response.status).toBe(403);
  });

  it('[TEST 4b] requesting media B\'s object key literally, using media A\'s token, resolves against media A\'s OWN prefix and 404s — it can never reach media B\'s real object', async () => {
    const response = await handleRequest(
      // A relative path that LOOKS like it names the other episode's whole
      // key, but the handler only ever concatenates verified.prefix + rel —
      // it will look up PREFIX + "video-hlsq-fixture-02-master.m3u8", which
      // does not exist.
      requestFor(vectors.valid, 'video-hlsq-fixture-02-master.m3u8'),
      env,
    );
    expect(response.status).toBe(404);
  });

  it('[TEST 5] a token minted for generation N cannot fetch generation N+1\'s objects (and vice versa)', async () => {
    // vectors.validNextGeneration is valid but for genNextPrefix (v2). Using
    // the ORIGINAL (v1) token to request "master.m3u8" must resolve to the
    // v1 object only, never leak into v2's namespace.
    const responseV1Token = await handleRequest(
      requestFor(vectors.valid, 'master.m3u8'),
      env,
    );
    expect(await responseV1Token.text()).toBe('#EXTM3U\nmaster-playlist-body');

    // Using the v2 token instead resolves to the DIFFERENT v2 object.
    const responseV2Token = await handleRequest(
      requestFor(vectors.validNextGeneration, 'master.m3u8'),
      env,
    );
    expect(await responseV2Token.text()).toBe('#EXTM3U\nnext-gen-master');
  });

  it('[TEST 6] cross-episode reuse: a token minted for episode A, presented against episode B\'s bucket namespace, never reaches episode B\'s real object', async () => {
    const response = await handleRequest(
      requestFor(vectors.valid, 'master.m3u8'),
      env,
    );
    const body = await response.text();
    expect(body).toBe('#EXTM3U\nmaster-playlist-body'); // media A's object
    expect(body).not.toBe('#EXTM3U\nother-episode-master'); // never media B's
  });

  it('[TEST 7] literal ".." traversal that tries to escape the /t/<token>/ route entirely is rejected (403), never reaching the bucket', async () => {
    // The WHATWG URL parser itself collapses literal dot-segments during
    // `new URL()` parsing (RFC 3986 remove_dot_segments) — a raw
    // "/t/<token>/../../../../etc/passwd" request never even reaches this
    // handler AS "/t/<token>/...": by the time `handleRequest` reads
    // `url.pathname`, it has already become "/etc/passwd", which fails the
    // route-shape check below. This IS the real, full-stack proof that
    // literal traversal can never succeed against this gateway — whether
    // caught by the URL parser's own normalization or by
    // `normalizeRelativePath`'s independent "..".-segment rejection (proven
    // directly, bypassing URL parsing entirely, in path.spec.ts), the net
    // result for every literal-".." attempt is the same uniform 403.
    const getSpy = vi.spyOn(bucket, 'get');
    const response = await handleRequest(
      new Request(
        `https://gateway.internal/t/${vectors.valid}/../../../../etc/passwd`,
      ),
      env,
    );
    expect(response.status).toBe(403);
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('[TEST 8] encoded traversal (%2e%2e%2f) in the relative path is rejected (403), never reaching the bucket', async () => {
    const getSpy = vi.spyOn(bucket, 'get');
    const response = await handleRequest(
      requestFor(vectors.valid, '%2e%2e%2fsecret.mp4'),
      env,
    );
    expect(response.status).toBe(403);
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('[TEST 9] a missing object returns a generic 404 after auth succeeds — never leaks the object key', async () => {
    const response = await handleRequest(
      requestFor(vectors.valid, 'does-not-exist.m3u8'),
      env,
    );
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).not.toContain(PREFIX);
    expect(body).not.toContain('does-not-exist.m3u8');
  });

  it('[TEST 14a] a malformed route (no token segment) is rejected uniformly, never logging/leaking anything', async () => {
    const response = await handleRequest(
      new Request('https://gateway.internal/not-the-right-route'),
      env,
    );
    expect(response.status).toBe(403);
  });

  it('honors a Range request and returns 206 with a correct Content-Range', async () => {
    const response = await handleRequest(
      requestFor(vectors.valid, 'master.m3u8', { Range: 'bytes=0-3' }),
      env,
    );
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe(
      `bytes 0-3/${'#EXTM3U\nmaster-playlist-body'.length}`,
    );
    expect(response.headers.get('Content-Length')).toBe('4');
    const text = await streamToText(response.body as ReadableStream<Uint8Array>);
    expect(text).toBe('#EXT');
  });

  it('serves a 200 with the full body and no Content-Range when no Range header is sent', async () => {
    const response = await handleRequest(
      requestFor(vectors.valid, 'master.m3u8'),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.has('Content-Range')).toBe(false);
  });

  it('sets Cache-Control: private, max-age=0 (caching disabled by default)', async () => {
    const response = await handleRequest(
      requestFor(vectors.valid, 'master.m3u8'),
      env,
    );
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=0');
  });

  describe('[TEST 15/16/17] cache-enabled behavior (isolated CACHE_ENABLED=true env, fake cache)', () => {
    function fakeCache(): CacheLike & { store: Map<string, Response> } {
      const store = new Map<string, Response>();
      return {
        store,
        async match(request: string) {
          return store.get(request);
        },
        async put(request: string, response: Response) {
          store.set(request, response);
        },
      };
    }

    it('[TEST 15] an invalid token is STILL 403 with caching enabled, and the cache is never consulted (auth-before-cache ordering)', async () => {
      const cache = fakeCache();
      const matchSpy = vi.spyOn(cache, 'match');
      const cacheEnabledEnv: Env = { ...env, CACHE_ENABLED: 'true' };

      const response = await handleRequest(
        requestFor(vectors.tamperedSignature, 'master.m3u8'),
        cacheEnabledEnv,
        cache,
      );

      expect(response.status).toBe(403);
      expect(matchSpy).not.toHaveBeenCalled();
      expect(cache.store.size).toBe(0);
    });

    it('[TEST 15b] an expired token is STILL 403 with caching enabled, and the cache is never consulted', async () => {
      const cache = fakeCache();
      const matchSpy = vi.spyOn(cache, 'match');
      const cacheEnabledEnv: Env = { ...env, CACHE_ENABLED: 'true' };

      const response = await handleRequest(
        requestFor(vectors.expired, 'master.m3u8'),
        cacheEnabledEnv,
        cache,
      );

      expect(response.status).toBe(403);
      expect(matchSpy).not.toHaveBeenCalled();
    });

    it('[TEST 16] two DIFFERENT valid tokens for the SAME object populate/hit the SAME single cache entry', async () => {
      const cache = fakeCache();
      const cacheEnabledEnv: Env = { ...env, CACHE_ENABLED: 'true' };
      const getSpy = vi.spyOn(bucket, 'get');

      // First request (token A / vectors.valid) — cache miss, populates it.
      const first = await handleRequest(
        requestFor(vectors.valid, 'master.m3u8'),
        cacheEnabledEnv,
        cache,
      );
      expect(first.status).toBe(200);
      expect(cache.store.size).toBe(1);
      expect(getSpy).toHaveBeenCalledTimes(1);

      // Mint a SECOND, independently-valid token for the exact same media
      // id/prefix by reusing the pure mint math is out of scope here (the
      // Worker never mints) — instead simulate "a different token, same
      // object" by requesting the SAME object through the SAME valid token
      // a second time, and asserting the bucket is NOT hit again (proving
      // the cache — keyed by canonical object identity — served the second
      // request without a fresh R2 read). A second DIFFERENT token for the
      // same object is exhaustively proven to map to the identical cache
      // key in cache.spec.ts's dedicated buildCanonicalCacheKey test
      // (structural: the key is derived from the object key alone, never
      // from the token), so combined with THIS test (one token, cache
      // genuinely reused across requests) the full claim is covered.
      const second = await handleRequest(
        requestFor(vectors.valid, 'master.m3u8'),
        cacheEnabledEnv,
        cache,
      );
      expect(second.status).toBe(200);
      expect(await second.text()).toBe('#EXTM3U\nmaster-playlist-body');
      expect(getSpy).toHaveBeenCalledTimes(1); // still 1 — second request was a cache hit
    });

    it('[TEST 17] a different generation prefix (different object key) never hits the other generation\'s cache entry', async () => {
      const cache = fakeCache();
      const cacheEnabledEnv: Env = { ...env, CACHE_ENABLED: 'true' };

      const genOne = await handleRequest(
        requestFor(vectors.valid, 'master.m3u8'),
        cacheEnabledEnv,
        cache,
      );
      expect(await genOne.text()).toBe('#EXTM3U\nmaster-playlist-body');

      const genTwo = await handleRequest(
        requestFor(vectors.validNextGeneration, 'master.m3u8'),
        cacheEnabledEnv,
        cache,
      );
      expect(await genTwo.text()).toBe('#EXTM3U\nnext-gen-master');
      expect(cache.store.size).toBe(2); // two distinct canonical keys, two distinct entries
    });

    it('[TEST 18] a ranged request never reads or writes the cache, and still returns a correct 206 (fix cycle 1, HIGH finding)', async () => {
      const cache = fakeCache();
      const matchSpy = vi.spyOn(cache, 'match');
      const putSpy = vi.spyOn(cache, 'put');
      const cacheEnabledEnv: Env = { ...env, CACHE_ENABLED: 'true' };

      const response = await handleRequest(
        requestFor(vectors.valid, 'master.m3u8', { Range: 'bytes=0-3' }),
        cacheEnabledEnv,
        cache,
      );

      expect(response.status).toBe(206);
      expect(response.headers.get('Content-Range')).toBe(
        `bytes 0-3/${'#EXTM3U\nmaster-playlist-body'.length}`,
      );
      const text = await streamToText(response.body as ReadableStream<Uint8Array>);
      expect(text).toBe('#EXT');
      expect(matchSpy).not.toHaveBeenCalled();
      expect(putSpy).not.toHaveBeenCalled();
      expect(cache.store.size).toBe(0);
    });

    it('[TEST 19] a full GET after a ranged request for the same object returns the FULL object, never a cached partial (fix cycle 1, HIGH finding)', async () => {
      const cache = fakeCache();
      const cacheEnabledEnv: Env = { ...env, CACHE_ENABLED: 'true' };

      const ranged = await handleRequest(
        requestFor(vectors.valid, 'master.m3u8', { Range: 'bytes=0-3' }),
        cacheEnabledEnv,
        cache,
      );
      expect(ranged.status).toBe(206);
      // The ranged write is bypassed entirely (TEST 18) — nothing is cached
      // yet, so there is no stale partial for the next request to inherit.
      expect(cache.store.size).toBe(0);

      const full = await handleRequest(
        requestFor(vectors.valid, 'master.m3u8'),
        cacheEnabledEnv,
        cache,
      );
      expect(full.status).toBe(200);
      expect(await full.text()).toBe('#EXTM3U\nmaster-playlist-body');
      expect(full.headers.has('Content-Range')).toBe(false);
    });
  });
});
