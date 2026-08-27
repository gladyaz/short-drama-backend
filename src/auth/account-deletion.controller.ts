import {
  Body,
  Controller,
  Get,
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
  WHATSAPP_OTP_REQUEST_RATE_LIMIT,
  WHATSAPP_OTP_REQUEST_RATE_TTL_MS,
} from '../common/rate-limit.constants';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { DeletionAuthorizationService } from './deletion/deletion-authorization.service';
import { AccountDeletionMethodsDto } from './deletion/deletion-authorization.types';
import { AccountDeletionDto } from './dto/account-deletion.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import type { AuthenticatedUser } from './guards/jwt-auth.guard';
import { WhatsAppOtpRequestResponseDto } from './identity/auth-identity.types';
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
  constructor(
    private readonly authService: AuthService,
    private readonly deletionAuthorization: DeletionAuthorizationService,
  ) {}

  /**
   * V1 PROVIDER ACCOUNT DELETION — `GET /users/me/deletion/methods`.
   *
   * THE ROUTE THAT MAKES THE OTHER TWO USABLE. A client cannot know whether
   * to render a password field, a "continue with Google" button or a
   * "send me a code" button without asking: the answer depends on which
   * identities the account owns AND on which providers this server can
   * currently verify. Guessing from `GET /auth/me` (is `email` null?) would
   * be a client-side re-derivation of a server-side policy — exactly the
   * kind of duplicate rule that produced the defect this work unit fixes.
   *
   * Read-only, `200`, and relies on the app-wide default throttler like
   * every other authenticated read (`GET /auth/sessions`,
   * `GET /auth/identities`): it mutates nothing, sends no message, and
   * reveals nothing about any account but the caller's own.
   */
  @Get('users/me/deletion/methods')
  @UseGuards(JwtAuthGuard)
  async deletionMethods(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AccountDeletionMethodsDto> {
    return {
      methods: await this.deletionAuthorization.availableMethods(user.id),
    };
  }

  /**
   * V1 PROVIDER ACCOUNT DELETION — `POST /users/me/deletion/whatsapp/otp`.
   *
   * Delivers a deletion-confirmation code to the number the AUTHENTICATED
   * caller's own account already has linked. There is no `phone` in the body
   * and no way to supply one: the number comes from the caller's own
   * `AuthIdentity` row, which is what binds the resulting challenge to this
   * account and keeps this authenticated route from becoming a new way to
   * send messages to arbitrary numbers.
   *
   * `202 Accepted`, matching `POST /auth/whatsapp/otp/request` exactly — the
   * server has accepted the request and will attempt delivery; the response
   * asserts nothing about whether a message arrived.
   *
   * THROTTLED WITH THE WHATSAPP OTP REQUEST BUDGET, deliberately reused
   * rather than given a near-identical twin: what this limit protects is the
   * cost and nuisance of a real WhatsApp message, which is the same cost
   * whichever route asked for it. The per-NUMBER cooldown and rolling budget
   * inside `WhatsAppOtpService` apply on top and count every challenge for
   * the number regardless of purpose, so a caller cannot double their own
   * message budget by alternating between the two routes.
   */
  @Post('users/me/deletion/whatsapp/otp')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(JwtAuthGuard)
  @Throttle({
    default: {
      limit: WHATSAPP_OTP_REQUEST_RATE_LIMIT,
      ttl: WHATSAPP_OTP_REQUEST_RATE_TTL_MS,
    },
  })
  requestWhatsAppDeletionOtp(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<WhatsAppOtpRequestResponseDto> {
    return this.deletionAuthorization.requestWhatsAppChallenge(
      user.id,
      requestContext(request),
    );
  }

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
