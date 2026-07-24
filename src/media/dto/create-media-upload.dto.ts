import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';

/**
 * Body of `POST /admin/media` (work unit 11B-3): metadata for a new media
 * record, created in the `draft` lifecycle state alongside a presigned
 * upload URL. Mirrors `VideoRecord`'s required fields (see
 * `video.types.ts`) minus `id`/`storageKey` (generated server-side) and
 * `likeCount` (always starts at 0).
 */
export class CreateMediaUploadDto {
  @IsString()
  @Length(1, 200)
  seriesId!: string;

  @IsString()
  @Length(1, 200)
  title!: string;

  @IsInt()
  @Min(1)
  episodeNumber!: number;

  @IsString()
  @Length(1, 200)
  channelName!: string;

  @IsString()
  @Length(1, 2000)
  caption!: string;

  @IsString()
  @Length(1, 100)
  category!: string;

  @IsString()
  @Length(1, 20)
  sourceLanguage!: string;

  @IsBoolean()
  hasEmbeddedIndonesianSubtitle!: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  durationSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  width?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  height?: number;

  /** Passed through to the presigned PUT URL's `Content-Type`, if provided. */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  contentType?: string;
}
