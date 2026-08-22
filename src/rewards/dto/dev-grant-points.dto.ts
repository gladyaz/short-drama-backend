import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { DEV_GRANT_MAX_POINTS } from '../rewards.constants';

/**
 * Body of the DEV-ONLY `POST /dev/rewards/grant` route, which exists so the
 * local Android demo can reach a redeemable balance without checking in for
 * forty consecutive days.
 *
 * `targetUserId` follows the `DevGrantEntitlementDto` precedent exactly:
 * optional, defaulting to the authenticated caller, present so cross-account
 * scenarios can be exercised. Reachable only when `DEV_TOOLS_ENABLED=true`,
 * which `env.validation.ts` refuses to boot with outside
 * `development`/`test`.
 */
export class DevGrantPointsDto {
  @IsOptional()
  @IsString()
  targetUserId?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(DEV_GRANT_MAX_POINTS)
  points!: number;

  /**
   * Required even on a dev route, and deliberately so: it keeps the demo
   * shortcut on the SAME idempotent path as every real movement, so a
   * double-tapped demo button cannot mint a second grant. A dev tool that
   * bypassed the ledger's guarantees would stop being a useful rehearsal of
   * the real thing.
   */
  @IsString()
  @Length(8, 128)
  @Matches(/^[A-Za-z0-9_:-]+$/)
  idempotencyKey!: string;
}
