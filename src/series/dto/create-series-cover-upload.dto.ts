import { IsIn, IsInt, Max, Min } from 'class-validator';
import {
  ALLOWED_SERIES_COVER_CONTENT_TYPES,
  MAX_SERIES_COVER_UPLOAD_BYTES,
} from '../series-cover.constants';

/**
 * Body of `POST /admin/series/:id/cover` (work unit "SERIES COVER UPLOAD
 * BACKEND CONTRACT"). Deliberately ONLY these two fields — no client-chosen
 * key, no free-form `contentType` (unlike the pre-existing
 * `CreateMediaAssetUploadDto`, which this route intentionally does NOT
 * reuse — see that DTO's class doc and `series-cover.constants.ts` for why
 * a cover needs its own, narrower policy).
 */
export class CreateSeriesCoverUploadDto {
  /** CLOSED allow-list — see `ALLOWED_SERIES_COVER_CONTENT_TYPES`'s doc comment. */
  @IsIn(ALLOWED_SERIES_COVER_CONTENT_TYPES)
  contentType!: string;

  /**
   * The size, in bytes, the client declares it is about to `PUT`. Bounded
   * to `MAX_SERIES_COVER_UPLOAD_BYTES` at request-validation time so an
   * obviously oversized request never even receives a presigned URL. This
   * is a request-time ceiling on the DECLARED value, not itself proof of
   * the real uploaded size — `POST /admin/series/:id/cover/complete`
   * independently re-checks the OBJECT's real, R2-reported size (via
   * `StorageService.headObject`) against the exact same bound before ever
   * persisting `Series.coverImageKey`.
   */
  @IsInt()
  @Min(1)
  @Max(MAX_SERIES_COVER_UPLOAD_BYTES)
  sizeBytes!: number;
}
