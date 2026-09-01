/**
 * Slice 11Q — Private HLS Delivery Gateway fetch handler (control-workspace
 * DECISIONS.md "2026-08-10 — Slice 11Q APPROVED..." entry; architecture:
 * proposals/phase-11-hls-pipeline-proposal.md §9/§9a). NOT deployed by this
 * slice — see `wrangler.toml.example`.
 *
 * Route: `GET /t/<token>/<relativePath>`.
 *
 * FIXED REQUEST ORDER (binding — approval item 5 / proposal §9's "Worker
 * request handling order is fixed"):
 *   1. parse the route shape (token segment + relative-path segment)
 *   2. verify the token (signature, shape, expiry) — `token.ts#verify`
 *   3. normalize the relative path — `path.ts#normalizeRelativePath`
 *   4. build the canonical object key from the TOKEN's own authorized
 *      prefix + the normalized relative path — `path.ts#buildObjectKey`
 *   5. ONLY NOW may the cache be consulted (`cache.ts`) — see that file's
 *      doc comment for the full §9a ordering proof — AND ONLY for a
 *      range-free request (fix cycle 1, HIGH finding): the canonical cache
 *      key (`cache.ts#buildCanonicalCacheKey`) has no Range component, so
 *      any request carrying a `Range` header bypasses the cache ENTIRELY,
 *      both read and write — see cache.ts's "ranged-request bypass" doc
 *      comment for why
 *   6. read from R2 (`env.MEDIA_BUCKET.get`), honoring Range requests
 *
 * Any failure in steps 1-4 returns a UNIFORM, detail-free 403 — malformed
 * route, malformed/bad-signature/expired token, traversal, and
 * prefix-escape are all indistinguishable to the caller (never leaks WHICH
 * check failed, the token, the secret, or the requested key). A failure at
 * step 6 (object not found) returns a generic 404 with no body detail —
 * this can only ever be reached AFTER authorization already succeeded.
 *
 * Work unit "HLS WEB PLAYBACK" adds exactly two things around — never
 * inside — that order, both no-ops unless `CORS_ALLOWED_ORIGINS` is
 * configured (see `cors.ts` for the full rationale and the security
 * rules):
 *
 *   0. an `OPTIONS` preflight from an ALLOW-LISTED origin is answered
 *      before anything else, deliberately without consulting the token
 *      (a preflight carries no credentials and reads no bytes; making its
 *      status depend on token validity would only build a validity
 *      oracle). Every other method, and any non-allow-listed origin, falls
 *      straight through to the unchanged pipeline below.
 *   7. every outgoing response — 403, 404, 200 and 206 alike, cached or
 *      freshly read — is rebuilt through `withCors`. Applying it LAST is
 *      what keeps the §9a cache origin-free: the entry stored in step 5's
 *      cache is the CORS-free response, so one origin's
 *      `Access-Control-Allow-Origin` can never be replayed to another.
 */

import { resolveContentType } from './content-type';
import { buildObjectKey, normalizeRelativePath } from './path';
import { parseRangeHeader, resolveReturnedRange } from './range';
import { maybeGetFromCache, maybePutInCache } from './cache';
import {
  buildPreflightResponse,
  parseAllowedOrigins,
  resolveAllowedOrigin,
  withCors,
} from './cors';
import { verify } from './token';
import type { CacheLike, Env } from './env.types';

const TOKEN_ROUTE_PREFIX = '/t/';

interface ParsedTokenRoute {
  rawToken: string;
  rawRelativePath: string;
}

/**
 * Splits `/t/<token>/<relativePath>` into its two segments. Deliberately
 * does NOT percent-decode or otherwise interpret either segment — that is
 * `token.ts`/`path.ts`'s job respectively, each applying its own strict
 * rules. Returns `null` for any pathname that doesn't have this exact
 * two-segment shape (no token, or no relative path at all after it).
 */
function parseTokenRoute(pathname: string): ParsedTokenRoute | null {
  if (!pathname.startsWith(TOKEN_ROUTE_PREFIX)) {
    return null;
  }

  const rest = pathname.slice(TOKEN_ROUTE_PREFIX.length);
  const slashIndex = rest.indexOf('/');
  if (slashIndex <= 0) {
    return null;
  }

  const rawToken = rest.slice(0, slashIndex);
  const rawRelativePath = rest.slice(slashIndex + 1);
  if (rawRelativePath.length === 0) {
    return null;
  }

  return { rawToken, rawRelativePath };
}

/**
 * Uniform, non-leaky 403 — used for EVERY authorization failure category
 * (malformed route, malformed token, bad signature, expired token,
 * traversal, prefix escape). Never includes the token, the requested path,
 * or any other request detail in the body.
 */
function forbiddenResponse(): Response {
  return new Response('Forbidden', {
    status: 403,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/** Generic 404 — reachable ONLY after authorization already succeeded. Never echoes the object key. */
function notFoundResponse(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Resolves the real Workers `caches.default` ONLY when caching is enabled
 * — deliberately never touched at all while `CACHE_ENABLED !== 'true'`
 * (the shipped default), so this line has zero effect in Node/vitest
 * (where no global `caches` exists) or in a real, still-disabled
 * deployment. `cacheOverride` (passed by tests) always takes precedence,
 * letting `index.spec.ts` exercise the cache-enabled path deterministically
 * with a plain fake, without needing miniflare or a real edge cache.
 */
function resolveCache(env: Env, cacheOverride?: CacheLike): CacheLike | undefined {
  if (cacheOverride) {
    return cacheOverride;
  }
  if (env.CACHE_ENABLED !== 'true') {
    return undefined;
  }

  const globalCaches = (globalThis as { caches?: { default?: CacheLike } })
    .caches;
  return globalCaches?.default;
}

/**
 * The whole request-handling pipeline, exported separately from the
 * `fetch` module export below so tests can call it directly with a fake
 * `Env`/`MediaBucket` and (optionally) a fake cache — no HTTP server, no
 * miniflare, no real Cloudflare runtime required.
 */
export async function handleRequest(
  request: Request,
  env: Env,
  cacheOverride?: CacheLike,
): Promise<Response> {
  const allowedOrigins = parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS);
  const corsConfigured = allowedOrigins.length > 0;
  const allowedOrigin = resolveAllowedOrigin(
    request.headers.get('origin'),
    allowedOrigins,
  );
  // Every exit below goes through this, so no early return can silently
  // omit the CORS headers a browser needs to accept even an error response.
  const respond = (response: Response): Response =>
    withCors(response, allowedOrigin, corsConfigured);

  if (request.method === 'OPTIONS') {
    const preflight = buildPreflightResponse(allowedOrigin);
    if (preflight) {
      return preflight;
    }
  }

  const url = new URL(request.url);
  const route = parseTokenRoute(url.pathname);
  if (!route) {
    return respond(forbiddenResponse());
  }

  // Step 2: verify the token BEFORE anything else touches the path or R2.
  const verified = await verify(route.rawToken, env.HLS_TOKEN_SECRET, nowSeconds());
  if (!verified) {
    return respond(forbiddenResponse());
  }

  // Step 3: normalize the client-supplied relative path independently of
  // the token — a valid token never grants license to skip path hygiene.
  const normalizedRelativePath = normalizeRelativePath(route.rawRelativePath);
  if (!normalizedRelativePath) {
    return respond(forbiddenResponse());
  }

  // Step 4: the object key is built ONLY from the token's OWN authorized
  // prefix (never any client-supplied prefix/key) + the normalized
  // relative path. A token minted for one media/generation can therefore
  // never address an object under a different media/generation's prefix,
  // regardless of what relative path is supplied.
  const objectKey = buildObjectKey(verified.prefix, normalizedRelativePath);
  if (!objectKey) {
    return respond(forbiddenResponse());
  }

  // Step 5: cache lookup — ONLY reachable after authorization succeeded,
  // keyed ONLY by the canonical object key (never the token/URL), and ONLY
  // for a range-free request. Detected structurally, BEFORE any cache call
  // and BEFORE the Range header is even parsed, so this bypass can never be
  // silently narrowed by a future change to `parseRangeHeader`'s parsing
  // rules: the RAW header's mere presence — not whether it happens to parse
  // successfully — is what routes a request around the cache entirely (see
  // cache.ts's "ranged-request bypass" doc comment for why).
  const isRangedRequest = request.headers.get('range') !== null;
  const cache = resolveCache(env, cacheOverride);
  const cached = isRangedRequest
    ? undefined
    : await maybeGetFromCache(cache, env.CACHE_ENABLED, objectKey);
  if (cached) {
    return respond(cached);
  }

  // Step 6: read from R2, honoring Range requests.
  const range = parseRangeHeader(request.headers.get('range'));
  const object = await env.MEDIA_BUCKET.get(
    objectKey,
    range ? { range } : undefined,
  );

  if (!object) {
    return respond(notFoundResponse());
  }

  const headers = new Headers({
    'Content-Type': resolveContentType(normalizedRelativePath),
    // Caching is disabled by default in this slice (§9a) — every response
    // is marked non-shareable/non-cacheable at the HTTP layer too, so an
    // intermediary never caches it on this gateway's behalf while the
    // in-Worker cache layer above is off.
    'Cache-Control': 'private, max-age=0',
    'Accept-Ranges': 'bytes',
    // CORS is NOT set here. The web-playback consumer this gateway now has
    // (hls.js in the Expo Web build) is served by `withCors` at the very
    // end of this function instead — see `cors.ts` for why applying it
    // there, rather than baking it into these headers, is what keeps the
    // §9a cache free of any origin-specific header. It remains absent
    // entirely unless `CORS_ALLOWED_ORIGINS` names an exact origin, and is
    // never a blanket `*`: these responses carry private media behind a
    // signed token.
  });

  let status = 200;
  // 11Q-A2 fix: emit 206 / Content-Range ONLY when the CLIENT actually sent a
  // valid Range request — `range` is the PARSED request range (from the
  // `parseRangeHeader` call above), which is non-null exactly when the client
  // asked for a byte range this gateway understood. It is NOT gated on
  // `object.range` alone: real Cloudflare R2's `.get()` populates
  // `R2Object.range` even on a FULL, non-ranged read, so gating on the
  // provider's field returned a bogus 206 for plain GETs — the exact defect
  // the live 11Q-A1 proof exposed (see HUMAN_ACTIONS.md CF-01). A malformed
  // Range header parses to `range = null`, so it also correctly falls through
  // to a full 200 (fail-safe), matching `parseRangeHeader`'s documented
  // "malformed -> serve the full object" contract. `object.range` is still
  // required in the guard so `resolveReturnedRange` has a real returned range
  // to resolve.
  if (range && object.range) {
    // The real `R2Object.range` is the three-variant `R2Range` union, so it
    // must be resolved against the object's total size before a
    // `Content-Range` can be built (11Q-A1 workers-types gate).
    const resolved = resolveReturnedRange(object.range, object.size);
    status = 206;
    headers.set('Content-Length', String(resolved.length));
    headers.set(
      'Content-Range',
      `bytes ${resolved.offset}-${resolved.offset + resolved.length - 1}/${object.size}`,
    );
  } else {
    headers.set('Content-Length', String(object.size));
  }

  const response = new Response(object.body, { status, headers });

  // Populate the cache (still a no-op while disabled) with a clone, so the
  // caller's own response body is never consumed by this side-effect. A
  // ranged request/response NEVER reaches this write (mirrors the read-side
  // bypass above) — this is what prevents a partial 206 body from ever
  // being stored under the range-blind canonical key and later served, in
  // full or in part, to an unrelated full-GET or differently-ranged
  // request for the same object.
  if (!isRangedRequest) {
    await maybePutInCache(cache, env.CACHE_ENABLED, objectKey, response.clone());
  }

  // LAST, and deliberately after the cache write above: the cached copy is
  // the CORS-free `response`, never this per-origin rebuild.
  return respond(response);
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
