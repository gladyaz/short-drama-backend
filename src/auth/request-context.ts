import type { Request } from 'express';
import { AuthRequestContext } from './auth.types';

/**
 * Phase 12, work unit 12A-B3: extracts the RAW client IP / `User-Agent`
 * header from the Express request so a controller can thread them through to
 * `AuthService`/`AuthAuditService`. Deliberately just a plain read of
 * `request.ip`/`request.get('user-agent')` — no `trust proxy` configuration
 * is set up in `main.ts`, matching this app's existing behavior everywhere
 * else (nothing in this repo today parses `X-Forwarded-For`); hashing/
 * truncation/sanitization all happen downstream in `AuthAuditService`/
 * `AuthService`, never here. `request.get(name)` (unlike indexing
 * `request.headers` directly) is Express's own typed accessor and always
 * returns a single `string | undefined` for any header name other than
 * `set-cookie`.
 *
 * Extracted out of `auth.controller.ts` (Phase 12, work unit 12C-B1) into its
 * own file so `AccountDeletionController` — a SEPARATE controller class,
 * needed because `AuthController`'s fixed `@Controller('auth')` prefix
 * cannot host a bare `/users/me/deletion` route — can reuse the exact same
 * extraction logic rather than duplicating it (and risking the two silently
 * diverging later, e.g. if `trust proxy` handling is ever added).
 */
export function requestContext(request: Request): AuthRequestContext {
  return {
    ip: request.ip,
    userAgent: request.get('user-agent'),
  };
}
