import { PresignedUploadDto } from '../media/media.types';

/**
 * Phase 11, work unit 11E-4 (extended in 11F-1): the admin-facing view of a
 * `Series` row. Returned as-is by `POST /admin/series`,
 * `PATCH /admin/series/:id`, and `POST /admin/series/:id/archive`/
 * `:id/unarchive`. Purely optional metadata about an existing
 * `Video.seriesId` grouping — this DTO is never exposed on the public feed
 * (`../videos/video.types.ts`), which stays unchanged by this work unit.
 */
export interface SeriesDto {
  id: string;
  title: string;
  coverImageKey: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  /**
   * Work unit 11F-1: `null` means active (not archived); an ISO 8601
   * timestamp means the series was soft-archived at that time via
   * `POST /admin/series/:id/archive`. Archived series are excluded from
   * `GET /admin/series` by default and only included when the caller
   * explicitly passes `includeArchived=true`.
   */
  archivedAt: string | null;
}

/**
 * Work unit "SERIES COVER UPLOAD BACKEND CONTRACT", acceptance criterion 5:
 * the read-surface shape for `GET /admin/series`, `GET /admin/series/:id`,
 * and `POST /admin/series/:id/cover/complete` — `SeriesDto` plus a
 * ready-to-use, presigned `coverUrl` (or `null` when no cover exists yet),
 * resolved via the same `resolveSeriesCoverUrl` helper the public
 * `GET /series`/`GET /series/:id` surface already uses (`./series-cover-url
 * .util.ts`), so the two can never drift. Deliberately NOT used by
 * `POST /admin/series`/`PATCH /admin/series/:id`/archive/unarchive (which
 * keep returning the plain `SeriesDto`, unchanged by this work unit) — only
 * the explicitly-listed read paths above need a fresh signed URL, and
 * minting one on every write would be an unnecessary R2 round trip.
 */
export interface SeriesWithCoverDto extends SeriesDto {
  /**
   * `null` when `coverImageKey` is unset, INCLUDING for an archived or
   * episode-less series — this DTO never omits or fabricates a cover for
   * either case, it just truthfully reports whatever `coverImageKey`
   * currently holds.
   */
  coverUrl: string | null;
}

/**
 * Response of `POST /admin/series/:id/cover` — reuses the exact same
 * `{ url, key, expiresAt }` shape `media/media.types.ts`'s
 * `PresignedUploadDto` already defines (the `AdminMediaService`
 * upload-initiate routes), rather than a second, drift-prone copy.
 * Deliberately does NOT include a `series`/`media` field the way
 * `MediaAssetUploadResponseDto` does — nothing is persisted on `Series` at
 * presign time (acceptance criterion 1: "NO `coverImageKey` mutation on
 * presign"), so there is nothing updated to echo back.
 */
export interface CreateSeriesCoverUploadResponseDto {
  upload: PresignedUploadDto;
}
