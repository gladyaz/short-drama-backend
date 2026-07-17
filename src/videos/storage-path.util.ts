import { resolve, sep } from 'path';
import { HttpStatus } from '@nestjs/common';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';

/**
 * Resolves a storageKey against STORAGE_ROOT and rejects any result that
 * escapes the root, defending against path traversal even though registered
 * storageKey values are internal, hardcoded data rather than user input.
 */
export function resolveSafeStoragePath(
  storageRoot: string,
  storageKey: string,
): string {
  const resolvedRoot = resolve(storageRoot);
  const resolvedPath = resolve(resolvedRoot, storageKey);

  const isInsideRoot =
    resolvedPath === resolvedRoot ||
    resolvedPath.startsWith(resolvedRoot + sep);

  if (!isInsideRoot) {
    throw new AppException(
      AppErrorCode.INVALID_STORAGE_PATH,
      'Resolved storage path is outside the storage root',
      HttpStatus.BAD_REQUEST,
    );
  }

  return resolvedPath;
}
