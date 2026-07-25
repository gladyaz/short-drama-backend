import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Work unit 11F-1: normalizes a query-string boolean ("true"/"false",
 * case-insensitive) into an actual `boolean` before `@IsBoolean()` below
 * validates it. class-transformer's `@Type(() => Boolean)` is deliberately
 * NOT used here — `Boolean("false")` evaluates to `true` in plain
 * JavaScript, which would silently make `?includeArchived=false` behave
 * like `true`, a real correctness bug this custom transform avoids. Any
 * value other than exactly `"true"`/`"false"` (case-insensitive) is passed
 * through unmodified, so `@IsBoolean()` still rejects it with a clean 400
 * (e.g. `?includeArchived=yes`) instead of this transform silently
 * coercing an invalid value into `false`.
 */
function toQueryBoolean(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  return value;
}

/**
 * Query params of `GET /admin/series` (work unit 11F-1, extending the
 * 11E-4 list route). `includeArchived` defaults to `undefined`
 * (falsy/excluded) when omitted — `SeriesService.list` treats any
 * non-`true` value the same as omitted, so archived rows stay excluded by
 * default and are only ever included via an explicit `includeArchived=true`.
 */
export class ListAdminSeriesQueryDto {
  @IsOptional()
  @Transform(({ value }) => toQueryBoolean(value))
  @IsBoolean()
  includeArchived?: boolean;
}
