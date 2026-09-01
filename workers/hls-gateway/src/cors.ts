/**
 * Work unit "HLS WEB PLAYBACK": a narrow, explicitly-configured CORS layer
 * for the private HLS delivery gateway.
 *
 * ## Why this exists
 *
 * Slice 11Q shipped this Worker with NO `Access-Control-*` headers at all,
 * and said so on purpose (see `index.ts`'s original header comment): native
 * HLS players (AVPlayer on iOS, Media3/ExoPlayer on Android, both reached
 * through `expo-video`) issue plain HTTP requests, not a web page's
 * `fetch()`, so no CORS response header is needed for them and none was
 * added. That reasoning is still correct — and it is exactly why nothing
 * below is on by default.
 *
 * It stopped being sufficient once a WEB consumer appeared. A browser HLS
 * engine (hls.js, which the Expo Web build now loads) fetches the master
 * playlist, every variant playlist and every segment via XHR/`fetch` from
 * the app's own origin. Without an `Access-Control-Allow-Origin` on each of
 * those responses the browser discards them, so web playback fails at the
 * very first manifest request no matter how healthy the pipeline behind it
 * is.
 *
 * ## The rules this module enforces
 *
 * 1. **Opt-in, absent by default.** With `CORS_ALLOWED_ORIGINS` unset or
 *    empty, `resolveAllowedOrigin` always returns `null` and not one
 *    `Access-Control-*` header is emitted — byte-identical to the
 *    pre-existing behavior for every existing (native) consumer.
 * 2. **Never `*`.** These objects are private media behind a signed token.
 *    A literal `*` is not merely discouraged here, it is unrepresentable:
 *    the only value ever echoed back is one that EXACTLY matched an entry
 *    in the configured allow-list, so an unlisted origin gets the same
 *    no-CORS response it gets today.
 * 3. **Always `Vary: Origin`.** The response genuinely differs per origin,
 *    so any intermediary (and the in-Worker cache layer, should §9a's
 *    cache ever be enabled) must key on it. This is set whenever the
 *    allow-list is configured at all — including for a REFUSED origin —
 *    because "this response had no ACAO" is itself an origin-dependent
 *    answer that must not be reused for a different, allowed origin.
 * 4. **CORS headers are added on the way OUT, never stored.** See
 *    `index.ts`: the object put into the §9a cache is the CORS-free
 *    response, and `withCors` builds a fresh response around it per
 *    request. A cache entry can therefore never carry one origin's ACAO
 *    into another origin's response — the classic CORS cache-poisoning
 *    shape — even though the canonical cache key has no origin component.
 */

/** Response headers a browser media engine must be able to read to do ranged/segmented playback. */
const EXPOSED_HEADERS = 'Content-Length, Content-Range, Accept-Ranges';

/**
 * Request headers a browser HLS engine may attach. `Range` is the only one
 * that matters in practice (segment byte-ranges); it is listed explicitly
 * rather than relying on it being CORS-safelisted, since that safelisting
 * is conditional on the header's exact syntax and differs between engines.
 */
const ALLOWED_REQUEST_HEADERS = 'Range';

const ALLOWED_METHODS = 'GET, HEAD, OPTIONS';

/** How long a browser may cache a preflight result. 1 hour — matches the default playback-token TTL. */
const PREFLIGHT_MAX_AGE_SECONDS = 3600;

/**
 * Splits the configured allow-list. Deliberately tolerant of surrounding
 * whitespace and empty entries (an operator editing a `[vars]` entry by
 * hand), and deliberately INTOLERANT of everything else: no wildcards, no
 * suffix matching, no scheme inference. An entry must be the exact origin
 * string a browser will send (`https://app.example.com`, no trailing
 * slash), because that is the only thing `resolveAllowedOrigin` compares
 * against.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The request's `Origin`, echoed back ONLY on an exact allow-list match.
 * Returns `null` for: no allow-list configured, no `Origin` header (a
 * native player, or a same-origin request), or an origin that is not
 * listed. `null` means "emit no `Access-Control-Allow-Origin`" — never
 * "emit `*`".
 */
export function resolveAllowedOrigin(
  requestOrigin: string | null,
  allowedOrigins: readonly string[],
): string | null {
  if (allowedOrigins.length === 0 || !requestOrigin) {
    return null;
  }

  return allowedOrigins.includes(requestOrigin) ? requestOrigin : null;
}

/**
 * Returns a NEW response carrying the same status/body plus this request's
 * CORS headers. The input response is never mutated, so a response already
 * handed to the cache layer cannot acquire an origin-specific header after
 * the fact.
 *
 * `corsConfigured` is passed separately from `allowedOrigin` so a REFUSED
 * origin still gets `Vary: Origin` (rule 3 above) without getting an
 * `Access-Control-Allow-Origin`.
 */
export function withCors(
  response: Response,
  allowedOrigin: string | null,
  corsConfigured: boolean,
): Response {
  if (!corsConfigured) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set('Vary', 'Origin');

  if (allowedOrigin) {
    headers.set('Access-Control-Allow-Origin', allowedOrigin);
    headers.set('Access-Control-Expose-Headers', EXPOSED_HEADERS);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * The response to a CORS preflight (`OPTIONS`) from an ALLOWED origin.
 *
 * Deliberately answered WITHOUT verifying the playback token. A preflight
 * carries no credentials and reads no bytes; its only job is to tell the
 * browser which methods/headers the real request may use. Verifying the
 * token here would make the preflight's status a token-validity oracle
 * (403 vs 204) for an attacker who cannot make the real request anyway —
 * strictly worse than answering uniformly. The REAL request that follows
 * is still fully verified by `index.ts`'s unchanged, fixed request order,
 * which is where authorization actually lives.
 *
 * Returns `null` when the origin is not allowed (or CORS is not
 * configured), so the caller falls through to its normal handling and an
 * unlisted origin learns nothing this route would not already tell it.
 */
export function buildPreflightResponse(
  allowedOrigin: string | null,
): Response | null {
  if (!allowedOrigin) {
    return null;
  }

  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': ALLOWED_METHODS,
      'Access-Control-Allow-Headers': ALLOWED_REQUEST_HEADERS,
      'Access-Control-Max-Age': String(PREFLIGHT_MAX_AGE_SECONDS),
      Vary: 'Origin',
    },
  });
}
