import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  ACCOUNT_DELETION_RATE_LIMIT,
  ACCOUNT_DELETION_RATE_TTL_MS,
} from '../common/rate-limit.constants';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { AccountDeletionDto } from './dto/account-deletion.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import type { AuthenticatedUser } from './guards/jwt-auth.guard';
import { requestContext } from './request-context';

/**
 * Phase 12, work unit 12C-B1: `POST /users/me/deletion` (DECISIONS.md
 * "Phase 12 ... approved..." entry, decision 1). A SEPARATE controller
 * class (not a route added to `AuthController`) purely because
 * `AuthController` carries a fixed `@Controller('auth')` prefix — this
 * route's frozen path is `/users/me/deletion`, not
 * `/auth/users/me/deletion`. Matches the existing
 * `InteractionsController`/`ProgressController`/`EntitlementsController`
 * precedent of a bare `@Controller()` (no prefix) for a route family that
 * lives outside its owning service's usual base path. `AuthService`
 * implements the actual behavior (`deleteAccount`) — this controller is
 * routing-only, exactly like those three.
 */
@Controller()
export class AccountDeletionController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Dedicated, tighter-than-default `@Throttle()` override — see
   * `ACCOUNT_DELETION_RATE_LIMIT`'s doc comment (`common/rate-limit.constants.ts`)
   * for the full reasoning: this is a DELIBERATE deviation from
   * `change-password`/`logout-all`/`sessions`'s established precedent of
   * relying on the app-wide default throttler for authenticated routes (see
   * `TASK_QUEUE.md`'s Phase 12 follow-ups, item 2), justified specifically
   * because this action is irreversible (no grace period, no cancellation —
   * DECISIONS.md decision 1).
   */
  @Post('users/me/deletion')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({
    default: {
      limit: ACCOUNT_DELETION_RATE_LIMIT,
      ttl: ACCOUNT_DELETION_RATE_TTL_MS,
    },
  })
  async deleteAccount(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AccountDeletionDto,
    @Req() request: Request,
  ): Promise<{ success: true }> {
    await this.authService.deleteAccount(user.id, dto, requestContext(request));
    return { success: true };
  }
}
