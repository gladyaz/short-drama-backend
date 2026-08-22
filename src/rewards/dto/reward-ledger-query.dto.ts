import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { LEDGER_PAGE_SIZE_MAX } from '../rewards.constants';

/**
 * Query for `GET /rewards/ledger`. `@Type(() => Number)` is required because
 * query-string values arrive as strings and the app-wide `ValidationPipe`
 * runs with `transform: true` — without it `@IsInt()` would reject every
 * request that supplies a limit at all.
 *
 * `limit` is bounded at both ends here AND re-clamped in the service. The
 * duplication is intentional: this DTO protects the HTTP surface, while the
 * service clamp protects every other caller (tests, future internal callers)
 * from an unbounded query against an append-only table that only ever grows.
 */
export class RewardLedgerQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LEDGER_PAGE_SIZE_MAX)
  limit?: number;

  /** Opaque cursor from a previous page's `nextCursor`. */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  cursor?: string;
}
