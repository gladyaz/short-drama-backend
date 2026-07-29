import {
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
  LOGIN_RATE_LIMIT,
  LOGIN_RATE_TTL_MS,
  PASSWORD_RESET_CONFIRM_RATE_LIMIT,
  PASSWORD_RESET_CONFIRM_RATE_TTL_MS,
  PASSWORD_RESET_REQUEST_RATE_LIMIT,
  PASSWORD_RESET_REQUEST_RATE_TTL_MS,
  REFRESH_RATE_LIMIT,
  REFRESH_RATE_TTL_MS,
  REGISTER_RATE_LIMIT,
  REGISTER_RATE_TTL_MS,
} from '../common/rate-limit.constants';
import { AuthService } from './auth.service';
import {
  AuthResponseDto,
  AuthUserDto,
  PasswordResetRequestResponseDto,
  SessionSummaryDto,
} from './auth.types';
import { CurrentUser } from './decorators/current-user.decorator';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import { PasswordResetConfirmDto } from './dto/password-reset-confirm.dto';
import { PasswordResetRequestDto } from './dto/password-reset-request.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import type { AuthenticatedUser } from './guards/jwt-auth.guard';
import { requestContext } from './request-context';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Phase 12, work unit 12A-B1: per-route IP rate limits (DECISIONS.md
  // "Phase 12 ... approved..." entry, decision 4). Each `@Throttle()` here
  // OVERRIDES the app-wide "default" throttler's generous limit
  // (`ThrottlerModule.forRoot` in `app.module.ts`) for just this route —
  // every other route keeps the generous default. Exceeding the limit
  // throws `ThrottlerException` (429), caught by the global
  // `AppExceptionFilter`'s generic `HttpException` branch — no
  // account-existence hint either way.
  @Post('register')
  @Throttle({
    default: { limit: REGISTER_RATE_LIMIT, ttl: REGISTER_RATE_TTL_MS },
  })
  register(
    @Body() dto: RegisterDto,
    @Req() request: Request,
  ): Promise<AuthResponseDto> {
    return this.authService.register(dto, requestContext(request));
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: LOGIN_RATE_LIMIT, ttl: LOGIN_RATE_TTL_MS } })
  login(
    @Body() dto: LoginDto,
    @Req() request: Request,
  ): Promise<AuthResponseDto> {
    return this.authService.login(dto, requestContext(request));
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    default: { limit: REFRESH_RATE_LIMIT, ttl: REFRESH_RATE_TTL_MS },
  })
  refresh(
    @Body() dto: RefreshTokenDto,
    @Req() request: Request,
  ): Promise<AuthResponseDto> {
    return this.authService.refresh(dto.refreshToken, requestContext(request));
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Body() dto: RefreshTokenDto): Promise<{ success: true }> {
    await this.authService.logout(dto.refreshToken);
    return { success: true };
  }

  /**
   * Minimal, concrete proof that `JwtAuthGuard` actually protects a route
   * end-to-end (Phase 8, work unit 8-B6). Not a general-purpose "profile"
   * endpoint — just the smallest possible authenticated route so future work
   * units have a working, tested example of `@UseGuards(JwtAuthGuard)` plus
   * `@CurrentUser()` to copy.
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: AuthenticatedUser): Promise<AuthUserDto> {
    return this.authService.getUserById(user.id);
  }

  /**
   * Phase 12, work unit 12B-B1 (DECISIONS.md "Phase 12 ... approved..."
   * entry, decision 7). See `AuthService.changePassword`'s doc comment for
   * the full design (why `refreshToken` is required in the body to identify
   * "the current session", the race-safe rotation, and the audit events).
   * No dedicated `@Throttle()` override here — this route is authenticated
   * (unlike `login`/`register`/`refresh`, which are reachable by anyone),
   * so it already falls under the app-wide default throttler like every
   * other authenticated route.
   */
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Req() request: Request,
  ): Promise<AuthResponseDto> {
    return this.authService.changePassword(
      user.id,
      dto,
      requestContext(request),
    );
  }

  /**
   * Phase 12, work unit 12B-B2 (DECISIONS.md "Phase 12 ... approved..."
   * entry, decision 6; runbook `.claude/plans/rfc-dag-safe-phase12.md`
   * flagged this endpoint's exact scope as an open ambiguity — "including
   * or excluding the current one ... decide and document explicitly, do
   * not leave it ambiguous" — this doc comment IS that resolution).
   *
   * FROZEN CONTRACT: "log out everywhere" — revokes EVERY session for the
   * authenticated caller's account, INCLUDING the session/device that made
   * THIS very request. There is deliberately no `refreshToken` in the
   * request body (unlike `change-password`/`refresh`/`logout`) to identify
   * "the current session" for exclusion, because this endpoint's whole
   * point is that no session is excluded. The "revoke every OTHER session
   * but keep me signed in" need this might otherwise seem to serve is
   * already met by `POST /auth/change-password` (work unit 12B-B1), which
   * exists specifically for that case — this endpoint is the OTHER, more
   * aggressive option, not a duplicate of it.
   *
   * Practical effect: every outstanding REFRESH token for the account stops
   * working immediately (any subsequent `POST /auth/refresh` gets `401
   * INVALID_REFRESH_TOKEN`, exactly like any other revoked session). The
   * ACCESS token this very request was authenticated with remains
   * cryptographically valid until it naturally expires (~15 min) — this
   * app's access tokens are stateless JWTs (`JwtAuthGuard` verifies them
   * without a database lookup) and that is a pre-existing property of the
   * whole auth system, not something unique to (or a gap introduced by)
   * this endpoint; `POST /auth/logout` has always had the exact same
   * property for the one session it revokes.
   */
  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async logoutAll(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<{ success: true }> {
    await this.authService.logoutAll(user.id, requestContext(request));
    return { success: true };
  }

  /**
   * Phase 12, work unit 12B-B2: lists ONLY the authenticated caller's OWN
   * currently-active sessions — never another account's, never a
   * `refreshTokenHash`/`ipHash`/any other hash or secret. See
   * `AuthService.listSessions`'s doc comment for the exact shape/filtering.
   */
  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  async listSessions(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SessionSummaryDto[]> {
    return this.authService.listSessions(user.id);
  }

  /**
   * Phase 12, work unit 12B-B2: ownership-scoped session revoke. Returns
   * `404 SESSION_NOT_FOUND` for a session id that does not exist AND for one
   * that exists but belongs to a DIFFERENT account — the exact same
   * response either way, so a cross-account revoke is impossible and this
   * endpoint cannot be used to probe which session ids exist for other
   * accounts (see `AuthService.revokeSession`'s doc comment). `204 No
   * Content` on success (revoke, not delete — the underlying row's
   * `revokedAt` is set, matching every other session-lifecycle action in
   * this codebase), mirroring `SeriesController.remove`'s existing
   * "nothing left to usefully return" precedent for a guarded destructive
   * action.
   */
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  async revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Req() request: Request,
  ): Promise<void> {
    await this.authService.revokeSession(user.id, id, requestContext(request));
  }

  /**
   * Phase 12, work unit 12B-B3 (DECISIONS.md "Phase 12 ... approved..."
   * entry, decision 3). Unauthenticated, like `login`/`register`/`refresh`
   * above — gets its own tight `@Throttle()` override for the same reason
   * (see `PASSWORD_RESET_REQUEST_RATE_LIMIT`'s doc comment for the exact
   * threshold/rationale). Deliberately NO `DevToolsGuard` here — see
   * `AuthService.requestPasswordReset`'s doc comment for why the dev-only
   * raw-token conditional lives in that method's response-shaping instead
   * of a route guard: this route must always return `202`, in every
   * environment, which a guard rejecting the whole route when
   * `DEV_TOOLS_ENABLED` is off would break.
   */
  @Post('password-reset/request')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({
    default: {
      limit: PASSWORD_RESET_REQUEST_RATE_LIMIT,
      ttl: PASSWORD_RESET_REQUEST_RATE_TTL_MS,
    },
  })
  requestPasswordReset(
    @Body() dto: PasswordResetRequestDto,
    @Req() request: Request,
  ): Promise<PasswordResetRequestResponseDto> {
    return this.authService.requestPasswordReset(dto, requestContext(request));
  }

  /**
   * Phase 12, work unit 12B-B3. Also unauthenticated (no `Authorization`
   * header — the single-use reset token itself is the only credential in
   * play), so it also gets its own tight `@Throttle()` override (see
   * `PASSWORD_RESET_CONFIRM_RATE_LIMIT`'s doc comment). See
   * `AuthService.confirmPasswordReset`'s doc comment for the full
   * single-use/expiry/revoke-all-sessions design.
   */
  @Post('password-reset/confirm')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    default: {
      limit: PASSWORD_RESET_CONFIRM_RATE_LIMIT,
      ttl: PASSWORD_RESET_CONFIRM_RATE_TTL_MS,
    },
  })
  async confirmPasswordReset(
    @Body() dto: PasswordResetConfirmDto,
    @Req() request: Request,
  ): Promise<{ success: true }> {
    await this.authService.confirmPasswordReset(dto, requestContext(request));
    return { success: true };
  }
}
