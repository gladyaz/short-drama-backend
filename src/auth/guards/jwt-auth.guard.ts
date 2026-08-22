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

/**
 * Work unit "ANONYMOUS FREE-EPISODE PLAYBACK": the three mutually exclusive
 * states an inbound `Authorization` header can be in, made explicit so the
 * one case that is legitimately allowed to proceed WITHOUT a user
 * (`'absent'` — no credential was supplied at all) can never be confused
 * with the case that must always fail (`'malformed'` — a credential WAS
 * supplied but is not a usable `Bearer <token>`).
 *
 * `'absent'` deliberately covers BOTH a missing header and a present but
 * empty/whitespace-only one: an empty header value carries no credential,
 * so there is nothing that could be "invalid" about it, and treating it as
 * anonymous grants strictly nothing a caller could not already get by
 * omitting the header entirely. Anything else non-empty — a non-`Bearer`
 * scheme, a bare `"Bearer"`, `"Bearer "` with no token — is `'malformed'`
 * and fails, so a broken/expired credential can never silently downgrade
 * itself into a guest (see `OptionalJwtAuthGuard`).
 */
type SuppliedCredential =
  | { kind: 'absent' }
  | { kind: 'bearer'; token: string }
  | { kind: 'malformed' };

function readSuppliedCredential(request: RequestWithUser): SuppliedCredential {
  const header = request.headers.authorization;

  if (header === undefined || header.trim().length === 0) {
    return { kind: 'absent' };
  }

  if (!header.startsWith(BEARER_PREFIX)) {
    return { kind: 'malformed' };
  }

  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? { kind: 'bearer', token } : { kind: 'malformed' };
}

export function invalidAccessToken(): AppException {
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
 *
 * Work unit "ANONYMOUS FREE-EPISODE PLAYBACK": the token-reading and
 * token-verifying half of this guard now lives in the reusable, protected
 * `resolveSuppliedUser` below, so `OptionalJwtAuthGuard` can reuse the
 * EXACT same parsing and verification rather than duplicating JWT handling
 * a second time. `canActivate`'s own behavior here is unchanged in every
 * case: any request without a fully valid bearer token still gets the same
 * generic 401 `INVALID_ACCESS_TOKEN` it always did.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<RootConfig>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = await this.resolveSuppliedUser(request);

    if (!user) {
      throw invalidAccessToken();
    }

    request.user = user;
    return true;
  }

  /**
   * Resolves the caller identity a request's `Authorization` header proves,
   * WITHOUT deciding whether the route tolerates an anonymous caller — that
   * decision belongs to the concrete guard (`JwtAuthGuard` refuses,
   * `OptionalJwtAuthGuard` allows).
   *
   * Returns `null` for EXACTLY ONE case: no credential was supplied at all
   * (`SuppliedCredential.kind === 'absent'`). Every other failure mode —
   * a non-`Bearer` scheme, an empty bearer token, a malformed/tampered/
   * expired token, a token whose payload has no `sub` — THROWS the same
   * generic 401 rather than returning `null`, so no subclass can ever turn
   * a broken credential into an anonymous request by accident. This is the
   * single load-bearing property that keeps optional auth from becoming an
   * authentication bypass.
   */
  protected async resolveSuppliedUser(
    request: RequestWithUser,
  ): Promise<AuthenticatedUser | null> {
    const credential = readSuppliedCredential(request);

    if (credential.kind === 'absent') {
      return null;
    }

    if (credential.kind === 'malformed') {
      throw invalidAccessToken();
    }

    const authConfig = this.configService.get('auth', { infer: true })!;

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<AccessTokenPayload>(
        credential.token,
        { secret: authConfig.jwtAccessSecret },
      );
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

    return { id: payload.sub };
  }
}
