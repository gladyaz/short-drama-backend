import { IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

/**
 * Body of `PATCH /admin/series/:id` (work unit 11E-4): a partial metadata
 * edit. Every field is optional, mirroring the exact same `class-validator`
 * constraint `CreateSeriesDto` applies to it, so an edit can never write a
 * value creation itself would have rejected.
 *
 * At least one field must be present in the body —
 * `AdminSeriesService.update` enforces that with a 400
 * (`AppErrorCode.EMPTY_SERIES_UPDATE`), matching the
 * `UpdateMediaMetadataDto`/`EMPTY_MEDIA_METADATA_UPDATE` precedent (work unit
 * 11E-2).
 *
 * Deliberately excludes `id` — it is immutable once created (the plain
 * `Video.seriesId` string this row annotates does not change). The global
 * `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` in
 * `main.ts` rejects a request body containing `id`, or any other
 * unrecognized field, with a 400 before this DTO is even constructed.
 */
export class UpdateSeriesDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  coverImageKey?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
