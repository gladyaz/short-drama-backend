import { IsOptional, IsString } from 'class-validator';

/**
 * Body of the dev-only `POST /dev/entitlements/revoke` route (work unit
 * 10-B5). `targetUserId` optional for the same reason as
 * `DevGrantEntitlementDto` — defaults to the authenticated caller.
 */
export class DevRevokeEntitlementDto {
  @IsOptional()
  @IsString()
  targetUserId?: string;
}
