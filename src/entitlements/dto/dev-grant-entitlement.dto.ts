import { IsISO8601, IsOptional, IsString } from 'class-validator';

/**
 * Body of the dev-only `POST /dev/entitlements/grant` route (work unit
 * 10-B5). `targetUserId` is optional so a caller can grant premium to their
 * own account (default: the authenticated user) or, for testing
 * cross-account scenarios, a different user id. `expiresAt` is optional;
 * omitting it grants a non-expiring entitlement.
 */
export class DevGrantEntitlementDto {
  @IsOptional()
  @IsString()
  targetUserId?: string;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}
