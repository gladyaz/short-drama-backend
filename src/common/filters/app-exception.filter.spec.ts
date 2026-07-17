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
});
