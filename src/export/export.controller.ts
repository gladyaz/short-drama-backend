import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthAuditService } from '../auth/auth-audit.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { requestContext } from '../auth/request-context';
import {
  DATA_EXPORT_RATE_LIMIT,
  DATA_EXPORT_RATE_TTL_MS,
} from '../common/rate-limit.constants';
import { ExportService } from './export.service';
import { UserExportDto } from './export.types';

/**
 * Phase 12, work unit 12C-B2: `GET /users/me/export` (DECISIONS.md "Phase 12
 * ... approved..." entry, decision 5). A SEPARATE controller class — not a
 * route added to `AuthController`/`InteractionsController` — for the same
 * reason `AccountDeletionController` is separate (see that controller's doc
 * comment): the route's frozen path is `/users/me/export`, and no existing
 * controller in this codebase carries a `@Controller()` prefix that would
 * host it without also changing every other route on that controller.
 * Matches the established `AccountDeletionController`/
 * `InteractionsController`/`ProgressController`/`EntitlementsController`
 * precedent of a bare `@Controller()` for a route family that lives outside
 * its owning module's usual base path.
 *
 * No id in the path or query, and the authenticated identity is read
 * exclusively from `@CurrentUser()` (populated by `JwtAuthGuard` from the
 * verified access token's `sub` claim) — there is nothing here for an IDOR
 * attempt to target: a caller cannot ask for anyone's export but their own.
 */
@Controller()
export class ExportController {
  constructor(
    private readonly exportService: ExportService,
    private readonly authAuditService: AuthAuditService,
  ) {}

  /**
   * See `DATA_EXPORT_RATE_LIMIT`'s doc comment (`common/rate-limit.constants.ts`)
   * for the full reasoning behind this dedicated, moderately tighter-than-
   * default `@Throttle()` override.
   *
   * `data_export_success` is emitted AFTER a successful export (best-effort,
   * never able to fail the request — see `AuthAuditService.emit`'s doc
   * comment) so a security investigation can later see "this account's data
   * was exported at this time," matching the operational-audit-trail
   * rationale this codebase already applies to every other account-lifecycle
   * action in this phase.
   */
  @Get('users/me/export')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({
    default: {
      limit: DATA_EXPORT_RATE_LIMIT,
      ttl: DATA_EXPORT_RATE_TTL_MS,
    },
  })
  async exportMyData(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<UserExportDto> {
    const result = await this.exportService.exportForUser(user.id);

    const context = requestContext(request);
    await this.authAuditService.emit('data_export_success', {
      userId: user.id,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return result;
  }
}
