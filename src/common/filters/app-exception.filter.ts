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
