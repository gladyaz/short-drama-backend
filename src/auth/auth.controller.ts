import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  LOGIN_RATE_LIMIT,
  LOGIN_RATE_TTL_MS,
  REFRESH_RATE_LIMIT,
  REFRESH_RATE_TTL_MS,
  REGISTER_RATE_LIMIT,
  REGISTER_RATE_TTL_MS,
} from '../common/rate-limit.constants';
import { AuthService } from './auth.service';
import { AuthResponseDto, AuthUserDto } from './auth.types';
import { CurrentUser } from './decorators/current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import type { AuthenticatedUser } from './guards/jwt-auth.guard';

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
  register(@Body() dto: RegisterDto): Promise<AuthResponseDto> {
    return this.authService.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: LOGIN_RATE_LIMIT, ttl: LOGIN_RATE_TTL_MS } })
  login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
    return this.authService.login(dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    default: { limit: REFRESH_RATE_LIMIT, ttl: REFRESH_RATE_TTL_MS },
  })
  refresh(@Body() dto: RefreshTokenDto): Promise<AuthResponseDto> {
    return this.authService.refresh(dto.refreshToken);
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
}
