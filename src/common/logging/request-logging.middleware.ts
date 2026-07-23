import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import type { RequestWithUser } from '../../auth/guards/jwt-auth.guard';
import { redactSensitiveText } from './redact';

/**
 * Phase 11, work unit 11-B1: one structured completion log line per HTTP
 * request — method, path (query string deliberately dropped, it could carry
 * tokens or PII), status, duration, and the authenticated user id when a
 * guard attached one. Logged on the response's `finish` event so the final
 * status code (including error responses produced by the exception filter)
 * is what gets recorded.
 */
@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(request: RequestWithUser, response: Response, next: NextFunction): void {
    const startedAt = Date.now();

    response.on('finish', () => {
      const path = (request.originalUrl ?? request.url ?? '').split('?')[0];
      const line = {
        method: request.method,
        path,
        statusCode: response.statusCode,
        durationMs: Date.now() - startedAt,
        ...(request.user ? { userId: request.user.id } : {}),
      };

      this.logger.log(redactSensitiveText(JSON.stringify(line)));
    });

    next();
  }
}
