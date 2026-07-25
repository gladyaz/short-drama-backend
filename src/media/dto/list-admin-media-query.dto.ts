import { Type } from 'class-transformer';
import {
  IsEnum,
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
