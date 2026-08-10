/**
 * Slice 11Q §9a — CACHE AMENDMENT (control-workspace DECISIONS.md,
 * 2026-08-10, binding on this slice). Ships DISABLED
 * (`cacheEnabled !== 'true'` ⇒ wholly bypassed, zero calls into `cache`).
 *
 * The amendment's core requirement: a playback token embeds itself in the
 * request PATH (`/t/<token>/<relativePath>`), which would otherwise make
 * every playback session its own distinct default cache key — defeating
 * shared edge caching for what is, underneath, the exact same immutable
 * object. This module's whole job is to cache by CANONICAL OBJECT IDENTITY
 * instead:
 *
 *   request with playback token
 *   -> validate authorization FIRST (index.ts: verify() + prefix containment)
 *   -> derive the canonical immutable object key (prefix + relative path —
 *      already computed by index.ts's `buildObjectKey`, which embeds
 *      mediaId + the immutable HLS generation prefix + the relative path;
 *      the token itself never appears in this key)
 *   -> cache by that canonical key, never by the raw token/URL
 *
 * ORDERING IS HARD-WIRED, not merely documented: `maybeGetFromCache` takes
 * an already-authorized `objectKey` as its ONLY key input — it has no
 * parameter through which a caller could pass the request URL or token
 * instead, and it performs no authorization decision of its own. Every
 * call site in `index.ts` is written so this function is reachable only
 * AFTER `verify()` + prefix-containment have both already succeeded (see
 * that file's fixed request order comment) — a cache lookup can never be
 * the FIRST thing that happens for a request.
 *
 * Security requirements this satisfies (verbatim from the approval):
 * - authorization happens before any cached private media is served —
 *   `index.ts` never calls this module until AFTER `verify()`+prefix
 *   containment succeed;
 * - a custom cache key never bypasses token validation — this module
 *   cannot be reached without a valid `objectKey`, which itself only
 *   exists once authorization has already succeeded;
 * - a cache entry can never make one episode readable with another
 *   episode's token — the cache key IS the canonical object key, which the
 *   prefix-containment check has already bound to the presented token's
 *   own authorized prefix; two different tokens for the SAME object
 *   collapse to the SAME cache key (proof 16), and two DIFFERENT
 *   generations (different immutable prefixes) can never collide (proof
 *   17), by construction of the key itself, not by a runtime check here.
 *
 * RANGED-REQUEST BYPASS (fix cycle 1, HIGH finding — binding on this
 * module): `buildCanonicalCacheKey` below is built from the object key
 * ALONE — it has no `Range`/byte-offset component. If a ranged (206
 * partial) response were ever stored under that same range-blind key, or a
 * cached full (200) response were ever served back to satisfy a ranged
 * request, either direction would silently corrupt playback for an
 * unrelated request sharing the same canonical object (e.g. client A's
 * `Range: bytes=0-3` partial getting cached and then served whole to
 * client B's plain full GET for the identical object, or vice versa).
 * `index.ts` is therefore written so that ANY request carrying a `Range`
 * header — detected structurally, before either `maybeGetFromCache` or
 * `maybePutInCache` is ever called — bypasses this module ENTIRELY, both
 * read and write. Only range-free requests may ever consult or populate
 * the cache. This module itself performs no Range-awareness of its own by
 * design: enforcing the bypass at the one call site (`index.ts`) rather
 * than duplicating a Range check inside `maybeGetFromCache`/
 * `maybePutInCache` keeps this module's cache-key contract simple (object
 * identity only) and keeps the bypass visible at the single place that
 * already knows about the incoming request.
 *
 * PURGE / INVALIDATION (documented, per the approval's explicit
 * requirement — this gateway never issues an explicit purge call): every
 * HLS generation lives under a fresh, immutable, unique prefix
 * (`admin-media/<mediaId>/hls/v<n>-a<n>-<uuid>/`, Slice 11P). A
 * re-transcode therefore produces an ENTIRELY NEW canonical object key —
 * a cache entry for a superseded generation is never "stale but still
 * served", it simply becomes permanently unreachable (nothing ever
 * requests that old canonical key again once `hlsMasterKey` has moved on).
 * Old entries are left to expire via ordinary HTTP cache TTL/eviction, not
 * explicit deletion. This is safe specifically because the backend's
 * `TranscodeJanitorService` cleanup grace period
 * (`TRANSCODE_CLEANUP_GRACE_MINUTES`, default 120 minutes) is deliberately
 * LONGER than the maximum HLS playback-token TTL (design target 30-60
 * minutes) — any token that could still name a since-superseded
 * generation's prefix would already be expired well before that
 * generation's R2 objects are actually deleted, so a live token can never
 * be paired with a still-cached-but-since-deleted object.
 */

import type { CacheLike } from './env.types';

/**
 * A fixed, internal, non-routable origin — never a real domain this
 * Worker is reachable at. Only its PATH (the object key) is meaningful;
 * this exists purely to give `Cache.match`/`Cache.put` a well-formed
 * cache-key string to key on, per the Workers Cache API's requirement
 * that cache keys look like request URLs.
 */
const HLS_CACHE_ORIGIN = 'https://hls-cache.internal';

export function buildCanonicalCacheKey(objectKey: string): string {
  return `${HLS_CACHE_ORIGIN}/${objectKey}`;
}

export function isCacheEnabled(cacheEnabledEnvValue: string | undefined): boolean {
  return cacheEnabledEnvValue === 'true';
}

/**
 * Returns `undefined` (a clean miss) whenever caching is disabled or no
 * cache implementation is available — NEVER throws, so a cache being
 * absent/misconfigured degrades to "always fetch from R2", never to a
 * failure.
 */
export async function maybeGetFromCache(
  cache: CacheLike | undefined,
  cacheEnabledEnvValue: string | undefined,
  objectKey: string,
): Promise<Response | undefined> {
  if (!isCacheEnabled(cacheEnabledEnvValue) || !cache) {
    return undefined;
  }

  return cache.match(buildCanonicalCacheKey(objectKey));
}

/** Symmetric no-op when caching is disabled/unavailable — never throws. */
export async function maybePutInCache(
  cache: CacheLike | undefined,
  cacheEnabledEnvValue: string | undefined,
  objectKey: string,
  response: Response,
): Promise<void> {
  if (!isCacheEnabled(cacheEnabledEnvValue) || !cache) {
    return;
  }

  await cache.put(buildCanonicalCacheKey(objectKey), response);
}
