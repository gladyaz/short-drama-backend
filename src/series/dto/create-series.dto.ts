import { IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

/**
 * Body of `POST /admin/series` (work unit 11E-4). `id` is REQUIRED and
 * client-provided (unlike `CreateMediaUploadDto`'s `id`, which is generated
 * server-side) — it is the existing plain-string `seriesId` convention
 * already used by `Video.seriesId` (e.g. "series-104"), so creating a
 * `Series` row means annotating an existing/planned grouping with a
 * client-chosen id, not minting a new opaque one. `AdminSeriesService.create`
 * rejects a duplicate `id` with a clean 409 (`AppErrorCode.SERIES_ALREADY_EXISTS`)
 * rather than letting a raw Postgres unique-constraint violation surface.
 */
export class CreateSeriesDto {
  @IsString()
  @Length(1, 200)
  id!: string;

  @IsString()
  @Length(1, 200)
  title!: string;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  coverImageKey?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
