import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { MediaLifecycleState } from '../media-lifecycle.types';

/**
 * Query params of `GET /admin/media` (work unit 11E-1): the admin inventory
 * list across ALL five lifecycle states (unlike the public feed, which only
 * ever returns `published` rows — see `VideosService`). Every field is
 * optional; `page`/`pageSize` fall back to their class-field defaults below
 * when the query omits them (class-transformer's `plainToInstance`, driven
 * by the global `ValidationPipe({ transform: true })` in `main.ts`,
 * constructs a new DTO instance and only overwrites fields present in the
 * incoming query string, so the field initializers below apply whenever a
 * param is missing).
 */
export class ListAdminMediaQueryDto {
  @IsOptional()
  @IsEnum(MediaLifecycleState)
  status?: MediaLifecycleState;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  seriesId?: string;

  /**
   * Work unit 11F-2: a case-insensitive substring filter, ANDed with every
   * other filter here. `AdminMediaService.list` matches this against
   * `title` OR `caption` OR `channelName` (a row matches if ANY of the
   * three contains it) — see the service for the exact Prisma `OR` shape.
   * `@Length(0, 200)` (not `1, 200`) is deliberate: `@IsOptional` only
   * skips validation for `null`/`undefined`, not `''`, so a `1, 200`
   * minimum would 400 on `?search=` (e.g. a cleared admin search box).
   * The service trims and treats empty/whitespace-only as absent, so
   * `?search=` or `?search=%20` behaves identically to omitting the
   * param entirely — the validator here must allow the empty string
   * through so the service can apply that behavior.
   */
  @IsOptional()
  @IsString()
  @Length(0, 200)
  search?: string;

  /**
   * Work unit 11F-2: filters on the DB-backed `Video.accessTierOverride`
   * column directly (11F-4 backfilled every row to a non-null value, so
   * this is a plain equality check — it does NOT re-derive the tier from
   * `episodeNumber`). `@IsIn`, not `@IsEnum`, matching the existing
   * `UpdateAccessTierDto` precedent for this same two-value set.
   */
  @IsOptional()
  @IsIn(['free', 'premium'])
  tier?: 'free' | 'premium';

  /**
   * Work unit 11F-2: an exact match on `Video.category` (e.g. "drama",
   * "comedy") — unlike `search`, this is not a substring/`contains` match.
   */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  category?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}
