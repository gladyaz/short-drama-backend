import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { RequestWithUser } from '../../auth/guards/jwt-auth.guard';
import { AppErrorCode } from '../../common/errors/app-error-code';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { ADMIN_ROLE } from '../admin.constants';

/**
 * Phase 11, work unit 11B-2: guards admin-only write/publish routes (the
 * 11B-3 `/admin/media` API). Mirrors `JwtAuthGuard`/`DevToolsGuard`'s
 * existing shape (a focused `CanActivate` reading exactly what it needs —
 * here, `PrismaService`, to look up the caller's current `role`) rather
 * than introducing a new guard-composition pattern.
 *
 * Must run AFTER `JwtAuthGuard` on any route (`@UseGuards(JwtAuthGuard,
 * AdminGuard)`) — it reads `request.user` populated by that guard and does
 * not itself verify the access token. The JWT payload only carries `sub`
 * (see `AccessTokenPayload`), not the role, so this guard always does one
 * DB lookup per request — an accepted per-request cost for a route that is
 * not on the hot path (unlike the public video feed/stream).
 *
 * A missing `request.user` (guard misconfigured/misordered) and a
 * caller whose role is not `"admin"` are deliberately collapsed into the
 * same `ADMIN_ROLE_REQUIRED`/403 outcome — this guard never returns 401
 * itself, since by the time it runs `JwtAuthGuard` has already accepted or
 * rejected the token.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const authenticatedUser = request.user;

    if (!authenticatedUser) {
      throw adminRoleRequired();
    }

    const user = await this.prisma.user.findUnique({
      where: { id: authenticatedUser.id },
      select: { role: true },
    });

    if (!user || user.role !== ADMIN_ROLE) {
      throw adminRoleRequired();
    }

    return true;
  }
}

function adminRoleRequired(): AppException {
  return new AppException(
    AppErrorCode.ADMIN_ROLE_REQUIRED,
    'Admin role required',
    HttpStatus.FORBIDDEN,
  );
}
