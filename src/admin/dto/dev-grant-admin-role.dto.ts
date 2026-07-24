import { IsOptional, IsString } from 'class-validator';

/**
 * Body of the DEV-ONLY `POST /dev/admin/grant-role` route (work unit
 * 11B-2), which stands in for a real admin-provisioning flow (none exists
 * yet). `targetUserId` optional — defaults to the authenticated caller,
 * mirroring `DevGrantEntitlementDto`'s existing precedent.
 */
export class DevGrantAdminRoleDto {
  @IsOptional()
  @IsString()
  targetUserId?: string;
}
