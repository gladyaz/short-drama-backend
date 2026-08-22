import { ExecutionContext, Injectable } from '@nestjs/common';
import { JwtAuthGuard, RequestWithUser } from './jwt-auth.guard';

/**
 * Work unit "ANONYMOUS FREE-EPISODE PLAYBACK": OPTIONAL authentication, not
 * absent authentication.
 *
 * This guard exists so a route can tell three states apart that
 * `JwtAuthGuard` deliberately collapses into one 401:
 *
 *   1. NO `Authorization` header at all      -> a valid ANONYMOUS request.
 *      `request.user` stays `undefined`; the handler proceeds and must make
 *      its own authorization decision for a guest (see
 *      `VideosController#enforceEntitlementGate`).
 *   2. A VALID `Authorization: Bearer <accessToken>` -> an AUTHENTICATED
 *      request. `request.user` is attached exactly as `JwtAuthGuard` would.
 *   3. A SUPPLIED but MALFORMED / INVALID / EXPIRED credential -> the SAME
 *      generic 401 `INVALID_ACCESS_TOKEN` `JwtAuthGuard` returns. It is
 *      NEVER downgraded to case 1.
 *
 * Case 3 is the whole reason this class is a three-line subclass rather
 * than a `try { jwtAuthGuard.canActivate() } catch { return true }` wrapper:
 * a catch-all wrapper would turn every expired or tampered token into an
 * anonymous request, which is precisely the authentication bypass this
 * work unit must not create. The distinction is enforced by the inherited
 * `resolveSuppliedUser`, which returns `null` for "no credential supplied"
 * and THROWS for every other failure — see its own doc comment.
 *
 * It carries no JWT parsing or verification of its own: parsing, secret
 * lookup, signature/expiry verification and payload-shape checking are all
 * the inherited, single-source-of-truth implementation, so this guard and
 * `JwtAuthGuard` can never drift on what counts as a valid token.
 *
 * A route using this guard MUST read its caller with `@OptionalCurrentUser()`
 * (which yields `AuthenticatedUser | undefined`), never `@CurrentUser()` —
 * the latter throws a 500 by design when no user is attached.
 */
@Injectable()
export class OptionalJwtAuthGuard extends JwtAuthGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = await this.resolveSuppliedUser(request);

    if (user) {
      request.user = user;
    }

    return true;
  }
}
