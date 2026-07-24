import { HttpStatus, Injectable } from '@nestjs/common';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { ADMIN_ROLE, DEFAULT_USER_ROLE } from './admin.constants';
import { AdminRoleStatusDto } from './admin.types';

/**
 * Phase 11, work unit 11B-2: the DEV-ONLY admin-role grant/revoke routes
 * this service backs stand in for a real admin-provisioning flow, matching
 * `EntitlementsService.devGrant`/`devRevoke`'s existing precedent (both are
 * gated by the same `DEV_TOOLS_ENABLED`/`DevToolsGuard`).
 */
@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async getRoleStatus(userId: string): Promise<AdminRoleStatusDto> {
    const user = await this.assertUserExists(userId);
    return { userId: user.id, role: user.role };
  }

  async devGrantAdminRole(userId: string): Promise<AdminRoleStatusDto> {
    await this.assertUserExists(userId);

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { role: ADMIN_ROLE },
    });

    return { userId: updated.id, role: updated.role };
  }

  async devRevokeAdminRole(userId: string): Promise<AdminRoleStatusDto> {
    await this.assertUserExists(userId);

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { role: DEFAULT_USER_ROLE },
    });

    return { userId: updated.id, role: updated.role };
  }

  /**
   * Mirrors `EntitlementsService.assertUserExists`: the dev-only routes
   * accept an arbitrary `targetUserId` string from the request body, so a
   * nonexistent id must surface as a clean 404 rather than a raw Prisma
   * "record to update not found" error.
   */
  private async assertUserExists(
    userId: string,
  ): Promise<{ id: string; role: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new AppException(
        AppErrorCode.USER_NOT_FOUND,
        'User not found',
        HttpStatus.NOT_FOUND,
      );
    }

    return user;
  }
}
