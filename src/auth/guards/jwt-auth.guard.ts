import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { RootConfig } from '../../config/configuration';
import { AppErrorCode } from '../../common/errors/app-error-code';
import { AppException } from '../../common/errors/app.exception';

/**
 * Shape of the decoded access-token JWT payload. Intentionally minimal to
 * match `AuthService.issueTokensAndSession`, which only ever signs `{ sub }`
 * (the user id) — never the password hash or any other sensitive field.
 */
export interface AccessTokenPayload {
  sub: string;
}

/**
 * Request-scoped user info attached by `JwtAuthGuard` after a successful
 * verification, so downstream handlers/decorators can read the authenticated
 * user's id without re-decoding the token.
 */
export interface AuthenticatedUser {
  id: string;
}

export interface RequestWithUser extends Request {
  user?: AuthenticatedUser;
}

const BEARER_PREFIX = 'Bearer ';

function invalidAccessToken(): AppException {
  // Deliberately generic (see `AppErrorCode.INVALID_ACCESS_TOKEN`): missing
  // header, malformed header, expired token, and invalid-signature token all
  // map to this same code/message/status, matching the
  // `INVALID_CREDENTIALS`/`INVALID_REFRESH_TOKEN` precedent elsewhere in this
  // module.
  return new AppException(
    AppErrorCode.INVALID_ACCESS_TOKEN,
    'Invalid or expired access token',
    HttpStatus.UNAUTHORIZED,
  );
}

/**
 * Guards a route by requiring a valid, unexpired `Authorization: Bearer
 * <accessToken>` header, verified against `JWT_ACCESS_SECRET` (the same
 * secret `AuthService` signs access tokens with). On success, attaches
 * `{ id: payload.sub }` to `request.user` so handlers (or `@CurrentUser()`)
 * can read the authenticated user's id.
 *
 * This guard only verifies the token's signature/expiry/shape; it does not
 * look up the user in the database (unlike refresh-token handling, which is
 * DB-backed session state). This keeps per-request auth cheap, at the cost of
 * not immediately reflecting a deleted/deactivated user until their access
 * token naturally expires (~15 min) — an accepted tradeoff for this phase.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<RootConfig>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = this.extractBearerToken(request);

    if (!token) {
      throw invalidAccessToken();
    }

    const authConfig = this.configService.get('auth', { infer: true })!;

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token, {
        secret: authConfig.jwtAccessSecret,
      });
    } catch {
      // `verifyAsync` throws for every failure mode we care about here
      // (expired, invalid signature, malformed token) — they are all mapped
      // to the same generic 401, so there is no need to branch on the
      // specific JWT error class.
      throw invalidAccessToken();
    }

    if (!payload?.sub) {
      throw invalidAccessToken();
    }

    request.user = { id: payload.sub };
    return true;
  }

  private extractBearerToken(request: RequestWithUser): string | undefined {
    const header = request.headers.authorization;

    if (!header || !header.startsWith(BEARER_PREFIX)) {
      return undefined;
    }

    const token = header.slice(BEARER_PREFIX.length).trim();
    return token.length > 0 ? token : undefined;
  }
}
