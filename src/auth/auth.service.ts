import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHmac, randomBytes } from 'crypto';
import type { User } from '@prisma/client';
import { RootConfig } from '../config/configuration';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import {
  ACCESS_TOKEN_TTL,
  BCRYPT_COST_FACTOR,
  DUMMY_HASH_FOR_TIMING_PARITY,
  REFRESH_TOKEN_BYTES,
  REFRESH_TOKEN_TTL_MS,
} from './auth.constants';
import { AuthResponseDto, AuthUserDto } from './auth.types';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

/**
 * Generic, user-enumeration-safe error used for both login and refresh
 * failures (see `AppErrorCode` for the security rationale).
 */
function invalidCredentials(): AppException {
  return new AppException(
    AppErrorCode.INVALID_CREDENTIALS,
    'Invalid email or password',
    HttpStatus.UNAUTHORIZED,
  );
}

function invalidRefreshToken(): AppException {
  return new AppException(
    AppErrorCode.INVALID_REFRESH_TOKEN,
    'Invalid or expired refresh token',
    HttpStatus.UNAUTHORIZED,
  );
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<RootConfig>,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResponseDto> {
    // Emails are stored and looked up case-insensitively (normalized to
    // lowercase) even though the `User.email` column itself is a
    // case-sensitive unique constraint: normalizing here ensures
    // "Foo@Bar.com" and "foo@bar.com" are treated as the same account for
    // both duplicate-registration detection and later login lookups.
    const email = dto.email.toLowerCase();
    const existing = await this.prisma.user.findUnique({
      where: { email },
    });

    if (existing) {
      throw new AppException(
        AppErrorCode.EMAIL_ALREADY_REGISTERED,
        'An account with this email already exists',
        HttpStatus.CONFLICT,
      );
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST_FACTOR);
    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        displayName: dto.displayName,
      },
    });

    return this.issueTokensAndSession(user);
  }

  async login(dto: LoginDto): Promise<AuthResponseDto> {
    const email = dto.email.toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    // Always run a bcrypt comparison, even when no user matches the email,
    // against a fixed dummy hash. This keeps the response latency for
    // "email not found" and "wrong password" statistically indistinguishable,
    // defending against timing-based user enumeration. The error thrown
    // below is identical in both cases regardless.
    const passwordMatches = await bcrypt.compare(
      dto.password,
      user?.passwordHash ?? DUMMY_HASH_FOR_TIMING_PARITY,
    );

    if (!user || !passwordMatches) {
      throw invalidCredentials();
    }

    return this.issueTokensAndSession(user);
  }

  async refresh(refreshToken: string): Promise<AuthResponseDto> {
    const refreshTokenHash = this.hashRefreshToken(refreshToken);
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash },
    });

    if (!session) {
      throw invalidRefreshToken();
    }

    const now = new Date();
    const isReuseOfRevokedToken = session.revokedAt !== null;
    const isExpired = session.expiresAt <= now;

    if (isReuseOfRevokedToken) {
      // A refresh token that was already rotated (or explicitly logged out)
      // being presented again is a strong signal of token theft: either an
      // attacker replayed a stolen token after the legitimate client already
      // rotated it, or a client bug is reusing a stale token. Defensively
      // revoke ALL of this user's other active sessions so a genuinely
      // stolen token chain is fully cut off, not just the one reused token.
      await this.prisma.session.updateMany({
        where: { userId: session.userId, revokedAt: null },
        data: { revokedAt: now },
      });
      throw invalidRefreshToken();
    }

    if (isExpired) {
      throw invalidRefreshToken();
    }

    const user = await this.prisma.user.findUnique({
      where: { id: session.userId },
    });

    if (!user) {
      throw invalidRefreshToken();
    }

    // Rotation: revoke the presented session and issue a brand new one
    // rather than updating the existing row in place, so the old refresh
    // token is permanently unusable (and any later reuse of it is detected
    // by the branch above).
    //
    // This is done as a conditional `updateMany` (rather than the earlier
    // `findUnique` → read `revokedAt` → `update` sequence) to close a
    // check-then-act race: if the same refresh token is presented twice
    // concurrently, both requests could otherwise observe `revokedAt: null`
    // before either write lands, and both would independently succeed.
    // `updateMany` with `revokedAt: null` in the `where` clause makes the
    // revoke atomic and conditioned on the row still being unrevoked at the
    // database level, so only one concurrent request can ever flip it. The
    // returned `count` tells us whether this request won that race.
    const { count } = await this.prisma.session.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: now },
    });

    if (count === 0) {
      // Someone else (a concurrent request racing on the same token) already
      // revoked this session between our read above and this write. Treat it
      // exactly like the already-revoked/reuse case: cut off all of this
      // user's other active sessions and refuse to issue new tokens.
      await this.prisma.session.updateMany({
        where: { userId: session.userId, revokedAt: null },
        data: { revokedAt: now },
      });
      throw invalidRefreshToken();
    }

    return this.issueTokensAndSession(user);
  }

  async logout(refreshToken: string): Promise<void> {
    const refreshTokenHash = this.hashRefreshToken(refreshToken);
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash },
    });

    // Idempotent and silent on an unknown/already-revoked token: logout is
    // not a place to reveal whether a given refresh token ever existed.
    if (!session || session.revokedAt) {
      return;
    }

    await this.prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Looks up a user by id for `GET /auth/me` (Phase 8, work unit 8-B6),
   * called with the `sub` from an already-verified access token
   * (`JwtAuthGuard`). If the user no longer exists (e.g. deleted after the
   * token was issued, since the guard itself does not hit the database),
   * this reuses the same generic invalid-access-token error rather than a
   * distinct "user not found" — the caller presented a token that no longer
   * corresponds to a valid session either way.
   */
  async getUserById(userId: string): Promise<AuthUserDto> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      throw new AppException(
        AppErrorCode.INVALID_ACCESS_TOKEN,
        'Invalid or expired access token',
        HttpStatus.UNAUTHORIZED,
      );
    }

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName ?? undefined,
    };
  }

  private async issueTokensAndSession(
    user: Pick<User, 'id' | 'email' | 'displayName'>,
  ): Promise<AuthResponseDto> {
    const authConfig = this.configService.get('auth', { infer: true })!;

    // Access token payload intentionally carries only the user id (`sub`) —
    // never the password hash or any other sensitive field.
    const accessToken = await this.jwtService.signAsync(
      { sub: user.id },
      { secret: authConfig.jwtAccessSecret, expiresIn: ACCESS_TOKEN_TTL },
    );

    const refreshToken = randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
    const refreshTokenHash = this.hashRefreshToken(refreshToken);

    await this.prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
      select: { id: true },
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName ?? undefined,
      },
      accessToken,
      refreshToken,
    };
  }

  /**
   * Refresh tokens are hashed with HMAC-SHA256 keyed by `JWT_REFRESH_SECRET`
   * (not plain SHA-256, and not bcrypt) before being persisted:
   * - Plain SHA-256 would be fine against brute force alone, since the
   *   refresh token is already 256 bits of random entropy (unlike a
   *   user-chosen password, there is no low-entropy guessing risk bcrypt's
   *   deliberate slowness defends against).
   * - Keying it (HMAC) with a server-side secret means a leak of the
   *   `Session` table alone (e.g. a DB dump) is not sufficient to forge a
   *   value that matches `refreshTokenHash` for a chosen token, and rotating
   *   `JWT_REFRESH_SECRET` invalidates all outstanding sessions at once if
   *   ever needed as an incident-response measure.
   * - A fast hash (vs. bcrypt) is deliberately used because refresh-token
   *   lookups happen on every refresh call and do not need bcrypt's
   *   deliberate slowness; that slowness exists specifically to defend
   *   against offline guessing of low-entropy secrets, which does not apply
   *   here.
   */
  private hashRefreshToken(token: string): string {
    const authConfig = this.configService.get('auth', { infer: true })!;
    return createHmac('sha256', authConfig.jwtRefreshSecret)
      .update(token)
      .digest('hex');
  }
}
