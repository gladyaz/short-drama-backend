/**
 * Phase 11, work unit 11E-4: the admin-facing view of a `Series` row.
 * Returned as-is by `GET /admin/series` (as `SeriesDto[]`), `POST
 * /admin/series`, and `PATCH /admin/series/:id`. Purely optional metadata
 * about an existing `Video.seriesId` grouping — this DTO is never exposed on
 * the public feed (`../videos/video.types.ts`), which stays unchanged by
 * this work unit.
 */
export interface SeriesDto {
  id: string;
  title: string;
  coverImageKey: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
