import { IsInt, IsOptional, Min } from 'class-validator';

/**
 * Body of `POST /admin/media/:id/complete-upload` (work unit 11B-3).
 * Optional refined metadata (e.g. from a client-side probe of the
 * uploaded file) — none of these fields are required to complete an
 * upload; the real ffprobe-derived values land via the 11D-1 bulk importer
 * or a future client-side probe step, not this route.
 */
export class CompleteMediaUploadDto {
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
}
