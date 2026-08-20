import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  GOOGLE_AUTH_RATE_LIMIT,
  GOOGLE_AUTH_RATE_TTL_MS,
  WHATSAPP_OTP_REQUEST_RATE_LIMIT,
  WHATSAPP_OTP_REQUEST_RATE_TTL_MS,
  WHATSAPP_OTP_VERIFY_RATE_LIMIT,
  WHATSAPP_OTP_VERIFY_RATE_TTL_MS,
} from '../../common/rate-limit.constants';
import { AuthResponseDto } from '../auth.types';
import { CurrentUser } from '../decorators/current-user.decorator';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../guards/jwt-auth.guard';
import { requestContext } from '../request-context';
import { AuthIdentityService } from './auth-identity.service';
import {
  isLinkableAuthProvider,
  LINKABLE_AUTH_PROVIDERS,
  LinkableAuthProvider,
} from './auth-identity.constants';
import {
  AuthIdentitySummaryDto,
  WhatsAppOtpRequestResponseDto,
} from './auth-identity.types';
import { GoogleSignInDto } from './dto/google-sign-in.dto';
import {
  WhatsAppOtpRequestDto,
  WhatsAppOtpVerifyDto,
} from './dto/whatsapp-otp.dto';

/**
 * PHASE 10B — PRODUCTION IDENTITY PROVIDERS: the HTTP surface for Google and
 * WhatsApp sign-in plus explicit account linking.
 *
 * Hosted on `AuthController`'s existing `auth` prefix so every
 * authentication route lives under one path family — but as a SEPARATE
 * controller class, matching this module's existing
 * `AccountDeletionController` precedent of splitting a route family out
 * rather than growing one controller indefinitely.
 *
 * ROUTING ONLY. Every decision — token verification, collision policy,
 * OTP consumption, last-method enforcement — lives in
 * `AuthIdentityService`, exactly as `AuthController` delegates to
 * `AuthService`.
 *
 * THROTTLING. The three UNAUTHENTICATED routes each carry their own tight
 * `@Throttle()` override, following the "every unauthenticated route gets an
 * explicit tight limit" precedent `login`/`register`/`refresh`/
 * `password-reset/*` already set. The four AUTHENTICATED link/list/unlink
 * routes deliberately rely on the app-wide default throttler, matching
 * `change-password`/`logout-all`/`sessions` — they are only reachable with a
 * valid access token, and the account-side damage a caller could do with one
 * is already bounded by the per-account rules the service enforces.
 */
@Controller('auth')
export class AuthIdentityController {
  constructor(private readonly authIdentityService: AuthIdentityService) {}

  /**
   * `POST /auth/google` — sign in or sign up with a Google ID token.
   *
   * `200`, not `201`, even when this call creates an account: the client
   * cannot know in advance which it will be (that depends on server state it
   * has no access to), and a status code that varies by outcome would be
   * both useless to branch on and an account-existence oracle. Matches
   * `POST /auth/login`'s explicit `@HttpCode(HttpStatus.OK)`.
   */
  @Post('google')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    default: { limit: GOOGLE_AUTH_RATE_LIMIT, ttl: GOOGLE_AUTH_RATE_TTL_MS },
  })
  signInWithGoogle(
    @Body() dto: GoogleSignInDto,
    @Req() request: Request,
  ): Promise<AuthResponseDto> {
    return this.authIdentityService.signInWithGoogle(
      dto,
      requestContext(request),
    );
  }

  /**
   * `POST /auth/whatsapp/otp/request` — request a one-time code.
   *
   * `202 Accepted`, mirroring `POST /auth/password-reset/request` exactly:
   * the server has accepted the request and will attempt delivery, and the
   * response deliberately says nothing about whether the number is known,
   * whether a message was actually delivered, or whether an account exists.
   */
  @Post('whatsapp/otp/request')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({
    default: {
      limit: WHATSAPP_OTP_REQUEST_RATE_LIMIT,
      ttl: WHATSAPP_OTP_REQUEST_RATE_TTL_MS,
    },
  })
  requestWhatsAppOtp(
    @Body() dto: WhatsAppOtpRequestDto,
    @Req() request: Request,
  ): Promise<WhatsAppOtpRequestResponseDto> {
    return this.authIdentityService.requestOtp(dto, requestContext(request));
  }

  /** `POST /auth/whatsapp/otp/verify` — sign in or sign up with a verified phone number. */
  @Post('whatsapp/otp/verify')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    default: {
      limit: WHATSAPP_OTP_VERIFY_RATE_LIMIT,
      ttl: WHATSAPP_OTP_VERIFY_RATE_TTL_MS,
    },
  })
  verifyWhatsAppOtp(
    @Body() dto: WhatsAppOtpVerifyDto,
    @Req() request: Request,
  ): Promise<AuthResponseDto> {
    return this.authIdentityService.verifyOtp(dto, requestContext(request));
  }

  /**
   * `GET /auth/identities` — the authenticated caller's OWN linked methods.
   * Never another account's, and never a raw `providerSubject` (see
   * `AuthIdentitySummaryDto`).
   */
  @Get('identities')
  @UseGuards(JwtAuthGuard)
  listIdentities(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AuthIdentitySummaryDto[]> {
    return this.authIdentityService.listIdentities(user.id);
  }

  /**
   * `POST /auth/identities/google/link` — link a Google account to the
   * authenticated caller's own account.
   *
   * REQUIRES AN AUTHENTICATED SESSION, which is the whole security property:
   * this route demands proof of BOTH sides (a valid Short Drama access token
   * AND a valid Google ID token) in a single request, which is why a
   * provider-email collision is never a path to taking over someone else's
   * account. Returns the caller's full, updated identity list so a client
   * needs no follow-up request to re-render.
   */
  @Post('identities/google/link')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  linkGoogle(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: GoogleSignInDto,
    @Req() request: Request,
  ): Promise<AuthIdentitySummaryDto[]> {
    return this.authIdentityService.linkGoogle(
      user.id,
      dto,
      requestContext(request),
    );
  }

  /**
   * `POST /auth/identities/whatsapp/link` — link a phone number to the
   * authenticated caller's own account, proving ownership by consuming a
   * real OTP in the same request. Same both-sides-proof property as the
   * Google link route above.
   */
  @Post('identities/whatsapp/link')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  linkWhatsApp(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: WhatsAppOtpVerifyDto,
    @Req() request: Request,
  ): Promise<AuthIdentitySummaryDto[]> {
    return this.authIdentityService.linkWhatsApp(
      user.id,
      dto,
      requestContext(request),
    );
  }

  /**
   * `DELETE /auth/identities/:provider` — unlink one of the caller's own
   * providers. Refused with `AUTH_LAST_IDENTITY` when it would leave the
   * account with no usable way to sign in.
   *
   * `:provider` accepts ONLY `google` or `whatsapp`. `email` is rejected
   * here as a plain `400` rather than given its own error code, because it
   * is not a policy refusal but an unroutable value: an `email` identity is
   * inseparable from `User.email`/`User.passwordHash`, whose lifecycle
   * belongs to the existing `register`/`change-password`/`password-reset`/
   * `account-deletion` flows (see `LINKABLE_AUTH_PROVIDERS`). Validated in
   * the handler rather than by a pipe so the allowlist and its reasoning
   * live in one place.
   *
   * Returns `200` with the updated identity list rather than `204`,
   * deliberately diverging from `DELETE /auth/sessions/:id`: after removing
   * a sign-in method the very next thing a client must know is what is left
   * and what is still removable, and making it ask again would leave a
   * window where its `canBeUnlinked` flags are stale.
   */
  @Delete('identities/:provider')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  unlinkIdentity(
    @CurrentUser() user: AuthenticatedUser,
    @Param('provider') provider: string,
    @Req() request: Request,
  ): Promise<AuthIdentitySummaryDto[]> {
    return this.authIdentityService.unlinkIdentity(
      user.id,
      parseLinkableProvider(provider),
      requestContext(request),
    );
  }
}

/**
 * A plain `BadRequestException`, deliberately NOT an `AppException` with its
 * own code. An unroutable path segment is the same class of failure the
 * global `ValidationPipe` produces for a bad body field, and it surfaces
 * through `AppExceptionFilter`'s generic `HttpException` branch as
 * `400 HTTP_ERROR` exactly like one. Minting a dedicated error code for it
 * would imply a policy decision was made about a real identity, when in fact
 * nothing was looked up at all — and reusing `AUTH_IDENTITY_NOT_FOUND` here
 * would contradict that code's documented 404 semantics.
 */
function parseLinkableProvider(value: string): LinkableAuthProvider {
  if (!isLinkableAuthProvider(value)) {
    throw new BadRequestException(
      `Unlinkable provider "${value}". Supported values: ${LINKABLE_AUTH_PROVIDERS.join(', ')}.`,
    );
  }
  return value;
}
