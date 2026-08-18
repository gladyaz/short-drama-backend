import {
  buildSeriesCoverObjectKeyPrefix,
  isValidSeriesCoverObjectKey,
} from '../series-cover-key.util';

/**
 * Slice "SERIES COVER ORPHAN CLEANUP LIFECYCLE": the AUTHORITATIVE namespace
 * boundary for the orphan sweep.
 *
 * Every Series-cover object key this backend has ever minted has the shape
 * `admin-series/<encodeURIComponent(seriesId)>/cover/<uuid v4>` — see
 * `../series-cover-key.util.ts`, the single builder. This root prefix is the
 * ONLY prefix the sweep enumerates, which is what structurally excludes
 * `admin-media/` (video sources, media covers, thumbnails, and every HLS
 * generation), `STORAGE_ROOT`-backed local paths, and any other object in the
 * bucket from ever becoming a deletion candidate: they are never returned by
 * the `ListObjectsV2` call in the first place, so no downstream filtering
 * mistake can reach them.
 */
export const SERIES_COVER_OBJECT_KEY_ROOT_PREFIX = 'admin-series/';

/** `admin-series` / `<encoded id>` / `cover` / `<uuid>` — exactly four segments, never more. */
const SERIES_COVER_KEY_SEGMENT_COUNT = 4;

/**
 * Recovers the `seriesId` a listed object key belongs to, or `null` when
 * `key` is not a well-formed Series-cover key.
 *
 * DELIBERATELY NOT a second, independent path parser. The decoded id is fed
 * straight back through `isValidSeriesCoverObjectKey` — the SAME predicate
 * `POST /admin/series/:id/cover/complete` uses to decide whether a caller's
 * key belongs to a series — and the parse is accepted only if that predicate
 * agrees. So this function can never classify as "a cover for series X" any
 * key that `buildSeriesCoverObjectKey(X)` could not have produced, and the
 * encoding rules stay defined in exactly one file. Concretely, that round
 * trip is what rejects a non-canonical encoding (`%2f` rather than `%2F`, a
 * gratuitously percent-encoded ASCII letter) which `decodeURIComponent`
 * alone would happily accept.
 *
 * Every rejection is fail-closed: an unparseable or non-canonical key is
 * simply NOT a candidate. The sweep counts it (`ignoredForeignKey`) and
 * moves on — it is never deleted on the theory that "it looks close enough".
 */
export function parseSeriesCoverObjectKey(
  key: string,
): { seriesId: string } | null {
  if (!key.startsWith(SERIES_COVER_OBJECT_KEY_ROOT_PREFIX)) {
    return null;
  }

  const segments = key.split('/');
  if (segments.length !== SERIES_COVER_KEY_SEGMENT_COUNT) {
    return null;
  }

  const encodedSeriesId = segments[1];
  if (encodedSeriesId.length === 0) {
    return null;
  }

  let seriesId: string;
  try {
    seriesId = decodeURIComponent(encodedSeriesId);
  } catch {
    // A malformed percent-escape (`%zz`, a truncated `%2`) throws URIError.
    return null;
  }

  // The round trip described above: the canonical builder's own validator is
  // the ONLY acceptance test, so a decoded id that would not re-encode to
  // this exact key is rejected.
  if (!isValidSeriesCoverObjectKey(seriesId, key)) {
    return null;
  }

  return { seriesId };
}

/**
 * Re-exported so callers reasoning about a single series' cover namespace
 * (docs, operator tooling, future per-series sweeps) reach for the SAME
 * builder the upload path uses rather than concatenating the pieces by hand.
 */
export { buildSeriesCoverObjectKeyPrefix };
