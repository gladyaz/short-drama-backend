import { IsInt, IsOptional, IsString, Min } from 'class-validator';

/**
 * Body of `PUT /series/:id/progress`, per the frozen Phase 9 contract.
 * `videoId` is the video the user was watching (validated against `Video`
 * existence in `ProgressService`); the `:id` path param is the series id,
 * which has no `Series` table to validate against (see `prisma/schema.prisma`
 * comment on `WatchProgress`).
 */
export class UpsertProgressDto {
  @IsString()
  videoId!: string;

  @IsInt()
  @Min(0)
  episodeNumber!: number;

  @IsInt()
  @Min(0)
  positionSeconds!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  durationSeconds?: number;
}
