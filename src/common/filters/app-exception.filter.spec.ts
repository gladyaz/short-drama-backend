import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { AppErrorCode } from '../errors/app-error-code';
import { AppException } from '../errors/app.exception';
import { AppExceptionFilter } from './app-exception.filter';

function createMockHost(): {
  host: ArgumentsHost;
  json: jest.Mock;
  status: jest.Mock;
} {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({}),
    }),
  } as unknown as ArgumentsHost;

  return { host, json, status };
}

describe('AppExceptionFilter', () => {
  it('formats an AppException using its own status and code', () => {
    const filter = new AppExceptionFilter();
    const { host, json, status } = createMockHost();

    filter.catch(
      new AppException(
        AppErrorCode.VIDEO_NOT_FOUND,
        'Video not found',
        HttpStatus.NOT_FOUND,
      ),
      host,
    );

    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(json).toHaveBeenCalledWith({
      statusCode: HttpStatus.NOT_FOUND,
      code: AppErrorCode.VIDEO_NOT_FOUND,
      message: 'Video not found',
    });
  });

  it('formats an unexpected error as a 500 without leaking internal details', () => {
    const filter = new AppExceptionFilter();
    const { host, json, status } = createMockHost();

    filter.catch(new Error('/Users/someone/secret/path failed to read'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
  });

  // Phase 12, work unit 12A-B2: middleware that runs before Nest's own
  // routing pipeline (e.g. body-parser's oversized-body rejection, wired up
  // in src/main.ts's 256kb JSON body limit) throws a plain `http-errors`
  // style error, never a Nest `HttpException`. Without special-casing this
  // shape, a legitimate 413 would previously have been misreported as a 500.
  it('formats an exposed http-errors-style client error (e.g. body-parser 413) using its own status and message', () => {
    const filter = new AppExceptionFilter();
    const { host, json, status } = createMockHost();

    const payloadTooLarge = Object.assign(
      new Error('request entity too large'),
      { status: 413, statusCode: 413, expose: true },
    );

    filter.catch(payloadTooLarge, host);

    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith({
      statusCode: 413,
      code: 'HTTP_ERROR',
      message: 'request entity too large',
    });
  });

  it('does NOT expose a non-exposed (expose: false) error, even with a 4xx status, and falls back to the generic 500', () => {
    const filter = new AppExceptionFilter();
    const { host, json, status } = createMockHost();

    const nonExposedError = Object.assign(
      new Error('/Users/someone/secret/internal-detail'),
      { status: 400, statusCode: 400, expose: false },
    );

    filter.catch(nonExposedError, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
  });

  it('does NOT expose an http-errors-style 5xx error (e.g. a third-party internal error) and falls back to the generic 500', () => {
    const filter = new AppExceptionFilter();
    const { host, json, status } = createMockHost();

    const serverError = Object.assign(
      new Error('/Users/someone/secret/internal-detail'),
      { status: 500, statusCode: 500, expose: false },
    );

    filter.catch(serverError, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
  });
});
