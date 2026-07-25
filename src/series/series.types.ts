/**
 * Phase 11, work unit 11E-4 (extended in 11F-1): the admin-facing view of a
 * `Series` row. Returned as-is by `GET /admin/series` (as `SeriesDto[]`),
 * `GET /admin/series/:id`, `POST /admin/series`, `PATCH /admin/series/:id`,
 * and `POST /admin/series/:id/archive`/`:id/unarchive`. Purely optional
 * metadata about an existing `Video.seriesId` grouping — this DTO is never
 * exposed on the public feed (`../videos/video.types.ts`), which stays
 * unchanged by this work unit.
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
