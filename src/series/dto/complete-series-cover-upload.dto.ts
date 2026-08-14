import { IsString, Length } from 'class-validator';

/**
 * Body of `POST /admin/series/:id/cover/complete` (work unit "SERIES COVER
 * UPLOAD BACKEND CONTRACT"). Carries back the exact `key` the preceding
 * `POST /admin/series/:id/cover` response minted — nothing is persisted at
 * presign time (see `SeriesService.createCoverUpload`'s doc comment), so
 * there is no server-recorded "pending" key to fall back on; the caller
 * must present it here. `SeriesService.completeCoverUpload` independently
 * verifies this key's ownership/shape (`isValidSeriesCoverObjectKey`)
 * before trusting it for anything — a well-formed-looking but unrelated
 * key (another series' cover, or an `admin-media/...` object) is rejected
 * before any `StorageService.headObject` call is even made.
 */
export class CompleteSeriesCoverUploadDto {
  @IsString()
  @Length(1, 500)
  key!: string;
}
