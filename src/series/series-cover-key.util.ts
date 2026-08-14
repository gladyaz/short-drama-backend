import { randomUUID } from 'crypto';

/**
 * Work unit "SERIES COVER UPLOAD BACKEND CONTRACT": deterministic,
 * traversal-proof object-storage key layout for a series cover image,
 * namespaced under `admin-series/`, mirroring `media/media-storage-key
 * .util.ts`'s `admin-media/<id>/...` convention for the same purpose.
 *
 * Unlike `Video.id` (server-generated via `randomUUID()`, see
 * `AdminMediaService.createUpload`), `Series.id` is CLIENT-PROVIDED at
 * create time (`CreateSeriesDto.id`, `@IsString() @Length(1, 200)`, no
 * format restriction beyond length) — e.g. the real catalog uses plain
 * slugs like `"series-104"`, but nothing at the DTO layer stops an admin
 * from choosing an id containing `/` or `..`. `encodeURIComponent` collapses
 * the ENTIRE id into a single path-safe segment (it escapes `/` to `%2F`,
 * so an id like `"../../admin-media/x"` becomes the literal, harmless
 * segment `"..%2F..%2Fadmin-media%2Fx"`), which is what makes the resulting
 * key traversal-proof: no `seriesId` value can ever cause the key to
 * resolve outside its own `admin-series/<id>/cover/` prefix.
 *
 * A per-upload version segment (`randomUUID()`) — NOT a static, unversioned
 * key like the pre-existing `admin-media/<id>/cover` — is required so that
 * re-presigning a NEW cover upload can never overwrite the bytes at the
 * CURRENTLY LIVE, already-verified key while it may still be in active use
 * (a client could be mid-download of the old cover via a presigned GET).
 * This is what makes "old cover stays authoritative until the new object is
 * verified, never cleared early" (the approved replace semantics) safe at
 * the object-storage level, not just at the `Series.coverImageKey` pointer
 * level.
 */
const SERIES_COVER_KEY_ROOT = 'admin-series';
const SERIES_COVER_KEY_SEGMENT = 'cover';

/** RFC 4122 v4 UUID, matching exactly what Node's `crypto.randomUUID()` produces. */
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The fixed prefix every valid cover object key for `seriesId` MUST start
 * with — used both to build a fresh key (`buildSeriesCoverObjectKey`) and to
 * verify OWNERSHIP of a key a caller presents back at completion time
 * (`isValidSeriesCoverObjectKey`).
 */
export function buildSeriesCoverObjectKeyPrefix(seriesId: string): string {
  return `${SERIES_COVER_KEY_ROOT}/${encodeURIComponent(seriesId)}/${SERIES_COVER_KEY_SEGMENT}/`;
}

/** A fresh, server-generated, versioned object key for a new cover upload. */
export function buildSeriesCoverObjectKey(seriesId: string): string {
  return `${buildSeriesCoverObjectKeyPrefix(seriesId)}${randomUUID()}`;
}

/**
 * Work unit "SERIES COVER UPLOAD BACKEND CONTRACT", acceptance criterion 2:
 * `POST /admin/series/:id/cover/complete` must reject a key belonging to a
 * DIFFERENT series or to an unrelated `admin-media/...` object. `true` only
 * when `key` starts with EXACTLY this series's cover prefix AND the
 * remainder is a well-formed UUID (the exact shape `buildSeriesCoverObjectKey`
 * always produces) — a strict allow-list shape check, not a loose
 * `.includes()`/`.startsWith()`-only test, so a crafted key with extra path
 * segments after the prefix (e.g. an attempted `../` escape smuggled in
 * post-prefix) can never pass.
 */
export function isValidSeriesCoverObjectKey(
  seriesId: string,
  key: string,
): boolean {
  const prefix = buildSeriesCoverObjectKeyPrefix(seriesId);

  if (!key.startsWith(prefix)) {
    return false;
  }

  const version = key.slice(prefix.length);
  return UUID_V4_PATTERN.test(version);
}
