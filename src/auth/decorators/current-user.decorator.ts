import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import type { RequestWithUser } from '../guards/jwt-auth.guard';

/**
 * Param decorator that reads the authenticated user attached to the request
 * by `JwtAuthGuard`. Only meaningful on routes actually protected by that
 * guard — using it elsewhere is a programming error, not a client error, so
 * it throws a 500 rather than silently returning `undefined`.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<RequestWithUser>();

    if (!request.user) {
      throw new InternalServerErrorException(
        '@CurrentUser() used on a route not protected by JwtAuthGuard',
      );
    }

    return request.user;
  },
);
