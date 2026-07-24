import { IsOptional, IsString } from 'class-validator';

/**
 * Body of the DEV-ONLY `POST /dev/admin/revoke-role` route (work unit
 * 11B-2). `targetUserId` optional for the same reason as
 * `DevGrantAdminRoleDto` — defaults to the authenticated caller.
 */
export class DevRevokeAdminRoleDto {
  @IsOptional()
  @IsString()
  targetUserId?: string;
}
