import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type {
  AuthenticatedUser,
  RequestWithUser,
} from '../guards/jwt-auth.guard';

/**
 * Work unit "ANONYMOUS FREE-EPISODE PLAYBACK": the `OptionalJwtAuthGuard`
 * counterpart to `@CurrentUser()`. Returns the authenticated user when the
 * request carried a valid access token, or `undefined` when it carried no
 * credential at all (a legitimate anonymous guest on an optional-auth
 * route).
 *
 * Deliberately does NOT throw on a missing user — that is the exact case
 * this decorator exists to express, unlike `@CurrentUser()`, whose 500 is
 * correct precisely because it is only ever used on `JwtAuthGuard`-protected
 * routes where a missing user can only mean a wiring mistake.
 *
 * Fails SAFE if misused on a route with no auth guard at all: the result is
 * `undefined`, i.e. "treat this caller as a guest", which every consumer
 * already handles as the least-privileged case — never as an implicitly
 * authenticated one.
 */
export const OptionalCurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser | undefined => {
    return ctx.switchToHttp().getRequest<RequestWithUser>().user;
  },
);
