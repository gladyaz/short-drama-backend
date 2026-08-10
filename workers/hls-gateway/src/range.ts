import type { MediaObjectRangeRequest } from './env.types';

/**
 * Slice 11Q — minimal `Range: bytes=...` header parser. Deliberately
 * fail-SAFE, not fail-throw: an absent or malformed Range header both
 * resolve to `null` ("serve the full object"), matching how a private,
 * single-purpose media gateway should treat a client sending a header it
 * doesn't understand — a native HLS player (AVPlayer/Media3) only ever
 * sends well-formed byte ranges in practice, so this never needs to
 * surface a 416 for the real traffic this gateway serves.
 *
 * Supports the two forms real players actually use:
 *   `bytes=<start>-<end>`  -> `{ offset: start, length: end - start + 1 }`
 *   `bytes=<start>-`       -> `{ offset: start }` (open-ended)
 *   `bytes=-<suffix>`      -> `{ suffix }` (last N bytes)
 * A `start > end` or otherwise malformed range returns `null`.
 */
const RANGE_HEADER_PATTERN = /^bytes=(\d*)-(\d*)$/;

export function parseRangeHeader(
  headerValue: string | null,
): MediaObjectRangeRequest | null {
  if (!headerValue) {
    return null;
  }

  const match = RANGE_HEADER_PATTERN.exec(headerValue.trim());
  if (!match) {
    return null;
  }

  const [, startStr = '', endStr = ''] = match;
  if (startStr === '' && endStr === '') {
    return null;
  }

  if (startStr === '') {
    const suffix = parseInt(endStr, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return null;
    }
    return { suffix };
  }

  const offset = parseInt(startStr, 10);
  if (!Number.isFinite(offset) || offset < 0) {
    return null;
  }

  if (endStr === '') {
    return { offset };
  }

  const end = parseInt(endStr, 10);
  if (!Number.isFinite(end) || end < offset) {
    return null;
  }

  return { offset, length: end - offset + 1 };
}
