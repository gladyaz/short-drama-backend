import { IsOptional, IsString, Length } from 'class-validator';

/**
 * Body of `POST /admin/media/:id/cover` and `POST /admin/media/:id/thumbnail`
 * (work unit 11B-3): a presigned PUT URL for the cover/thumbnail image,
 * same shape for both since neither needs anything beyond an optional
 * `Content-Type`.
 */
export class CreateMediaAssetUploadDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  contentType?: string;
}
