import { IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

/**
 * Body of `PATCH /admin/series/:id` (work unit 11E-4; `coverImageKey`'s
 * explicit null-clear semantics added by work unit "SERIES COVER UPLOAD
 * BACKEND CONTRACT", acceptance criterion 4): a partial metadata edit.
 * Every field is optional, mirroring the exact same `class-validator`
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

  /**
   * Three distinct, explicitly-typed states — not an accidental side
   * effect of `class-validator`'s `@IsOptional()` (which happens to treat
   * both `null` and `undefined` as "skip further validators" at the
   * library level, but that alone does not make the CONTRACT explicit):
   * - `undefined` (field omitted from the body): unchanged.
   * - `null`: explicitly clears the cover (`SeriesService.update` writes a
   *   real `null` to `Series.coverImageKey`, not a no-op).
   * - a non-empty string (1–500 chars): sets/replaces the raw object key,
   *   same constraint as `CreateSeriesDto.coverImageKey` and as before this
   *   work unit.
   *
   * In normal operation `coverImageKey` is set via the verified
   * `POST /admin/series/:id/cover` + `.../cover/complete` flow, never by
   * writing an unverified key directly through this route — but this route
   * remains the only way to CLEAR it (there is no dedicated
   * `DELETE .../cover` route; clearing is expressed as this existing,
   * general-purpose PATCH with an explicit `null`).
   */
  @IsOptional()
  @IsString()
  @Length(1, 500)
  coverImageKey?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
