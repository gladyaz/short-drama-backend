import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DevGrantEntitlementDto } from './dto/dev-grant-entitlement.dto';
import { DevRevokeEntitlementDto } from './dto/dev-revoke-entitlement.dto';
import { EntitlementStatusDto } from './entitlement.types';
import { EntitlementsService } from './entitlements.service';
import { DevToolsGuard } from './guards/dev-tools.guard';

/**
 * Phase 10, work units 10-B4/10-B5. `/dev/entitlements/*` routes are
 * additionally gated by `DevToolsGuard` (disabled unless
 * `DEV_TOOLS_ENABLED=true`, which the app refuses to boot with in
 * production — see `env.validation.ts`). They stand in for a real payment
 * webhook, which is explicitly out of scope for this phase.
 */
@Controller()
export class EntitlementsController {
  constructor(private readonly entitlementsService: EntitlementsService) {}

  @UseGuards(JwtAuthGuard)
  @Get('users/me/entitlement')
  getMyEntitlement(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<EntitlementStatusDto> {
    return this.entitlementsService.getStatus(user.id);
  }

  @UseGuards(JwtAuthGuard, DevToolsGuard)
  @Post('dev/entitlements/grant')
  devGrant(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: DevGrantEntitlementDto,
  ): Promise<EntitlementStatusDto> {
    return this.entitlementsService.devGrant(
      body.targetUserId ?? user.id,
      body.expiresAt,
    );
  }

  @UseGuards(JwtAuthGuard, DevToolsGuard)
  @Post('dev/entitlements/revoke')
  devRevoke(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: DevRevokeEntitlementDto,
  ): Promise<EntitlementStatusDto> {
    return this.entitlementsService.devRevoke(body.targetUserId ?? user.id);
  }
}
