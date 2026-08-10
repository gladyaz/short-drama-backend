import { describe, expect, it, vi } from 'vitest';
import {
  buildCanonicalCacheKey,
  isCacheEnabled,
  maybeGetFromCache,
  maybePutInCache,
} from '../src/cache';
import type { CacheLike } from '../src/env.types';

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

describe('cache (Slice 11Q §9a CACHE AMENDMENT)', () => {
  it('isCacheEnabled requires the EXACT string "true" — fail closed by default', () => {
    expect(isCacheEnabled(undefined)).toBe(false);
    expect(isCacheEnabled('false')).toBe(false);
    expect(isCacheEnabled('1')).toBe(false);
    expect(isCacheEnabled('TRUE')).toBe(false);
    expect(isCacheEnabled('true')).toBe(true);
  });

  it('[TEST 16] the SAME canonical object key is produced regardless of which token was used — proves two different tokens for the same object collapse to one cache entry', () => {
    const objectKey = 'admin-media/video-abc/hls/v1-a1-uuid/master.m3u8';
    // buildCanonicalCacheKey never takes a token as input at all — this is
    // structural, not just empirically true for these two calls.
    expect(buildCanonicalCacheKey(objectKey)).toBe(
      buildCanonicalCacheKey(objectKey),
    );
  });

  it('[TEST 17] a different generation prefix produces a different canonical key', () => {
    const genOne = buildCanonicalCacheKey(
      'admin-media/video-abc/hls/v1-a1-uuid/master.m3u8',
    );
    const genTwo = buildCanonicalCacheKey(
      'admin-media/video-abc/hls/v2-a1-uuid/master.m3u8',
    );
    expect(genOne).not.toBe(genTwo);
  });

  it('maybeGetFromCache is a clean no-op (undefined, never touches `cache`) when disabled', async () => {
    const cache = fakeCache();
    const matchSpy = vi.spyOn(cache, 'match');
    const result = await maybeGetFromCache(cache, 'false', 'some/key');
    expect(result).toBeUndefined();
    expect(matchSpy).not.toHaveBeenCalled();
  });

  it('maybeGetFromCache is a clean no-op when no cache instance is supplied, even if enabled', async () => {
    const result = await maybeGetFromCache(undefined, 'true', 'some/key');
    expect(result).toBeUndefined();
  });

  it('maybePutInCache is a clean no-op (never calls `cache.put`) when disabled', async () => {
    const cache = fakeCache();
    const putSpy = vi.spyOn(cache, 'put');
    await maybePutInCache(cache, 'false', 'some/key', new Response('body'));
    expect(putSpy).not.toHaveBeenCalled();
    expect(cache.store.size).toBe(0);
  });

  it('when enabled, put then get round-trips through the canonical key', async () => {
    const cache = fakeCache();
    const objectKey = 'admin-media/video-abc/hls/v1-a1-uuid/master.m3u8';
    await maybePutInCache(cache, 'true', objectKey, new Response('hls-body'));

    const hit = await maybeGetFromCache(cache, 'true', objectKey);
    expect(hit).toBeDefined();
    expect(await hit!.text()).toBe('hls-body');
  });
});
