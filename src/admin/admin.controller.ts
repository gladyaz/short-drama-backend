import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DevToolsGuard } from '../entitlements/guards/dev-tools.guard';
import { AdminService } from './admin.service';
import { DevGrantAdminRoleDto } from './dto/dev-grant-admin-role.dto';
import { DevRevokeAdminRoleDto } from './dto/dev-revoke-admin-role.dto';
import { AdminGuard } from './guards/admin.guard';
import { AdminRoleStatusDto } from './admin.types';

/**
 * Phase 11, work unit 11B-2. `/admin/whoami` demonstrates/exercises
 * `AdminGuard` end-to-end (401 no token / 403 non-admin / 200 admin) ahead
 * of 11B-3's real `/admin/media` routes, which will reuse the same guard.
 * `/dev/admin/*` routes are additionally gated by `DevToolsGuard`
 * (`DEV_TOOLS_ENABLED=true` only), mirroring `EntitlementsController`'s
 * existing `/dev/entitlements/*` precedent — they stand in for a real
 * admin-provisioning flow, which does not exist yet.
 */
@Controller()
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('admin/whoami')
  whoami(@CurrentUser() user: AuthenticatedUser): Promise<AdminRoleStatusDto> {
    return this.adminService.getRoleStatus(user.id);
  }

  @UseGuards(JwtAuthGuard, DevToolsGuard)
  @Post('dev/admin/grant-role')
  devGrantAdminRole(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: DevGrantAdminRoleDto,
  ): Promise<AdminRoleStatusDto> {
    return this.adminService.devGrantAdminRole(body.targetUserId ?? user.id);
  }

  @UseGuards(JwtAuthGuard, DevToolsGuard)
  @Post('dev/admin/revoke-role')
  devRevokeAdminRole(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: DevRevokeAdminRoleDto,
  ): Promise<AdminRoleStatusDto> {
    return this.adminService.devRevokeAdminRole(body.targetUserId ?? user.id);
  }
}
