/**
 * Work unit "PRODUCTION SMOKE TEST": the rules a playback URL must satisfy
 * before a Play Store build may be pointed at the API that produced it.
 *
 * These live in `src/` rather than inline in the script so they are unit
 * tested. They are the whole point of the smoke test: an API can answer 200
 * on every route and still be useless, because `GET /videos/:id/playback`
 * hands back a URL only reachable from the developer's LAN. That failure is
 * invisible to a health check and invisible to the mobile release preflight
 * (which validates the API BASE url, not the media URLs the API returns).
 */

import { isLoopbackHostname, isPrivateHostname } from '../net/public-host';

/** Why a playback URL is not usable from a phone on the public internet. */
export type PlaybackUrlRejection =
  | 'missing'
  | 'unparseable'
  | 'not_https'
  | 'loopback_host'
  | 'private_lan_host'
  | 'contains_filesystem_path';

export interface PlaybackUrlVerdict {
  ok: boolean;
  rejection: PlaybackUrlRejection | null;
  detail: string;
}

/**
 * Judges one playback URL. Ordered most-fundamental-first so the reported
 * reason is the one an operator should act on: an absent URL is not "not
 * https", and an unparseable string is not "a LAN address".
 */
export function judgePlaybackUrl(
  url: string | null | undefined,
): PlaybackUrlVerdict {
  if (typeof url !== 'string' || url.trim().length === 0) {
    return {
      ok: false,
      rejection: 'missing',
      detail: 'playback response carried no URL',
    };
  }

  // Checked on the RAW string, before parsing: an absolute filesystem path
  // leaking into a URL is a backend bug worth naming precisely, and some
  // shapes of it parse as a valid URL rather than failing below.
  if (url.includes('/Users/') || url.includes('\\Users\\')) {
    return {
      ok: false,
      rejection: 'contains_filesystem_path',
      detail: `URL contains a developer filesystem path: ${url}`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      ok: false,
      rejection: 'unparseable',
      detail: `not a valid absolute URL: ${url}`,
    };
  }

  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      rejection: 'not_https',
      detail: `scheme is ${parsed.protocol} — Android 9+ blocks cleartext: ${url}`,
    };
  }

  if (isLoopbackHostname(parsed.hostname)) {
    return {
      ok: false,
      rejection: 'loopback_host',
      detail: `host is loopback (${parsed.hostname}) — unreachable from a phone`,
    };
  }

  if (isPrivateHostname(parsed.hostname)) {
    return {
      ok: false,
      rejection: 'private_lan_host',
      detail: `host is a private/LAN address (${parsed.hostname}) — unreachable from the public internet`,
    };
  }

  return {
    ok: true,
    rejection: null,
    detail: `${parsed.protocol}//${parsed.host}`,
  };
}

/**
 * A byte-range request against media is acceptable at 206 (the server
 * honored the range) or 200 (it ignored the range and sent the whole
 * object). Both let a player start. Anything else — notably 403 from an
 * expired/misconfigured presigned URL, or 404 from an object that was never
 * uploaded — means the catalog is linked to media that does not serve.
 */
export function isAcceptableMediaStatus(status: number): boolean {
  return status === 200 || status === 206;
}
