import { HttpStatus } from '@nestjs/common';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { resolveSafeStoragePath } from './storage-path.util';

describe('resolveSafeStoragePath', () => {
  const storageRoot = '/company/storage';

  it('resolves a valid relative storageKey inside the root', () => {
    expect(resolveSafeStoragePath(storageRoot, 'series/episode-001.mp4')).toBe(
      '/company/storage/series/episode-001.mp4',
    );
  });

  it('rejects a storageKey that traverses outside the root', () => {
    let caught: unknown;
    try {
      resolveSafeStoragePath(storageRoot, '../../etc/passwd');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppException);
    expect((caught as AppException).code).toBe(
      AppErrorCode.INVALID_STORAGE_PATH,
    );
    expect((caught as AppException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
  });

  it('rejects an absolute storageKey pointing outside the root', () => {
    expect(() => resolveSafeStoragePath(storageRoot, '/etc/passwd')).toThrow(
      AppException,
    );
  });
});
