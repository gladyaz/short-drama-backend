import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import type { RequestWithUser } from '../../auth/guards/jwt-auth.guard';
import { redactSensitiveText } from '../logging/redact';
import { AppException } from '../errors/app.exception';

interface HttpExceptionBody {
  message?: string | string[];
}

/**
 * The `http-errors` package's error shape (used internally by Express's own
 * middleware — e.g. `body-parser`/`raw-body` throw a `PayloadTooLargeError`
 * this way for an oversized request body, see the 256kb JSON body limit
 * added in Phase 12, work unit 12A-B2). These errors are thrown by
 * middleware that runs *before* Nest's own routing/exception pipeline, so
 * they are never a Nest `HttpException` — without this check they would
 * fall through to the generic 500 branch below and misreport a genuine
 * client error (e.g. 413) as a server failure.
 */
interface StatusCarryingError extends Error {
  status?: number;
  statusCode?: number;
  /**
   * `http-errors` convention: `true` only for 4xx errors whose `message` is
   * safe to expose to the client (e.g. "request entity too large"); `false`
   * for its own internal 5xx errors, whose message must NOT be exposed —
   * checking this flag keeps this branch from ever leaking an unexpected
   * third-party 5xx error's raw message the way the generic AppException/
   * HttpException branches above already avoid doing for their own cases.
   */
  expose?: boolean;
}

function getExposedClientErrorStatus(exception: unknown): number | null {
  if (!(exception instanceof Error)) {
    return null;
  }
  const err = exception as StatusCarryingError;
  const status = err.status ?? err.statusCode;
  const isExposedClientError =
    err.expose === true &&
    typeof status === 'number' &&
    status >= 400 &&
    status < 500;

  return isExposedClientError ? status : null;
}

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<RequestWithUser>();

    if (exception instanceof AppException) {
      const status = exception.getStatus();
      response.status(status).json({
        statusCode: status,
        code: exception.code,
        message: exception.message,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const rawMessage =
        typeof body === 'string'
          ? body
          : ((body as HttpExceptionBody).message ?? exception.message);

      response.status(status).json({
        statusCode: status,
        code: 'HTTP_ERROR',
        message: Array.isArray(rawMessage) ? rawMessage.join(', ') : rawMessage,
      });
      return;
    }

    const exposedClientErrorStatus = getExposedClientErrorStatus(exception);
    if (exposedClientErrorStatus !== null) {
      response.status(exposedClientErrorStatus).json({
        statusCode: exposedClientErrorStatus,
        code: 'HTTP_ERROR',
        message: (exception as Error).message,
      });
      return;
    }

    // Phase 11, work unit 11-B4: log unhandled exceptions with enough
    // request context to debug (method, path, authenticated user id when a
    // guard attached one), with the whole line passed through the
    // redaction layer so a stack frame or message can never leak secrets
    // or absolute internal storage paths. Reads are defensive — the filter
    // also runs in unit tests whose mock request is an empty object.
    const context = {
      method: request?.method,
      path: (request?.originalUrl ?? request?.url ?? '').split('?')[0],
      ...(request?.user ? { userId: request.user.id } : {}),
    };
    const detail =
      exception instanceof Error
        ? (exception.stack ?? exception.message)
        : String(exception);

    this.logger.error(
      redactSensitiveText(
        `Unhandled exception ${JSON.stringify(context)}: ${detail}`,
      ),
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
  }
}
