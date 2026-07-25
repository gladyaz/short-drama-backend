import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';

/**
 * Body of `PATCH /admin/media/:id` (work unit 11E-2): a partial metadata
 * edit. Every field is optional (unlike `CreateMediaUploadDto`, where the
 * same seven fields are required), but each one mirrors the exact same
 * `class-validator` constraint `CreateMediaUploadDto` applies to it, so an
 * edit can never write a value creation itself would have rejected.
 *
 * At least one field must be present in the body —
 * `AdminMediaService.updateMetadata` enforces that with a 400
 * (`AppErrorCode.EMPTY_MEDIA_METADATA_UPDATE`), since class-validator has
 * no built-in way to express "at least one of these N independently-optional
 * fields" as a single per-field decorator.
 *
 * Deliberately excludes every other `Video` column — `lifecycleState`,
 * `objectStorageKey`/`objectStorageVariant`, `coverImageKey`/
 * `thumbnailImageKey`, `storageKey`, `sortOrder`, `likeCount`,
 * `durationSeconds`/`width`/`height`, and `accessTierOverride` are all out
 * of scope for this route; each either has its own dedicated route already
 * (lifecycle transitions, asset uploads, or — for `accessTierOverride`,
 * work unit 11E-3 — `PATCH /admin/media/:id/access-tier`) or is never
 * admin-editable via this endpoint. The global
 * `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` in
 * `main.ts` rejects a request body containing any of those, or any other
 * unrecognized field, with a 400 before this DTO is even constructed.
 */
export class UpdateMediaMetadataDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(1, 2000)
  caption?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  category?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  channelName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 20)
  sourceLanguage?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  episodeNumber?: number;

  @IsOptional()
  @IsBoolean()
  hasEmbeddedIndonesianSubtitle?: boolean;
}
