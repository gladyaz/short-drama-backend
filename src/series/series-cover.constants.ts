/**
 * Work unit "SERIES COVER UPLOAD BACKEND CONTRACT" (approved 2026-08-14,
 * see the control workspace's `DECISIONS.md` and
 * `phases/phase-series-metadata.md` §"Work unit 2"): named-constant policy
 * for `POST /admin/series/:id/cover` (presign) and
 * `POST /admin/series/:id/cover/complete` (verify + persist).
 *
 * Deliberately its OWN policy, separate from `media/media-upload.constants
 * .ts`'s `MAX_UPLOAD_BYTES`/`media/dto/create-media-upload.dto.ts`'s
 * `ALLOWED_UPLOAD_CONTENT_TYPES` — those describe the ~2 GiB video-source
 * upload; a series cover is a small, static display image with a
 * completely different risk/size profile, so reusing the video ceiling
 * would be meaningless (far too large to be a real bound) and reusing the
 * video MIME allow-list would be wrong (a cover is never `video/mp4`).
 */

/**
 * CLOSED image MIME allow-list — no `image/svg+xml` (SVG can embed script/
 * external references — an XSS/SSRF-adjacent risk class this contract
 * deliberately excludes), no `video/*`, no `application/*`. All three
 * formats are broadly supported by browsers, CDNs, and standard
 * server-side image tooling; `image/webp` in particular is confirmed
 * supported by every layer this project's stack actually touches for
 * cover art (a presigned R2 PUT/GET pair and a `<img>`/React Native
 * `Image` consumer on the client side — R2 stores arbitrary bytes under
 * whatever `Content-Type` was declared, so no server-side format
 * transcoding is involved here that could reject it).
 */
export const ALLOWED_SERIES_COVER_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type AllowedSeriesCoverContentType =
  (typeof ALLOWED_SERIES_COVER_CONTENT_TYPES)[number];

/**
 * 10 MiB (`10 * 1024 * 1024` = 10,485,760 bytes). Justification: a series
 * cover is a single static poster image displayed at feed/detail-card size
 * on mobile and in an admin dashboard grid — it is never streamed,
 * transcoded, or served frame-by-frame like `Video` source content. 10 MiB
 * comfortably covers even an uncompressed, high-resolution (e.g. 4K) PNG/
 * WebP poster with generous headroom, while staying two orders of
 * magnitude below `media/media-upload.constants.ts`'s `MAX_UPLOAD_BYTES`
 * (~2 GiB, the video-source ceiling) — a poster is not, and should never
 * become, a multi-hundred-megabyte asset. This is an APPLICATION-level
 * policy bound (defense against an admin account being used to stash
 * oversized objects under this prefix), not an infrastructure limit — R2
 * itself permits far larger single-PUT objects.
 */
export const MAX_SERIES_COVER_UPLOAD_BYTES = 10 * 1024 * 1024;
