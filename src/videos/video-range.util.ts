import { HttpStatus } from '@nestjs/common';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';

export interface ParsedRange {
  start: number;
  end: number;
}

const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;

/**
 * Parses an HTTP Range header against a known file size.
 * Returns null when no Range header was supplied (caller should send a full 200 response).
 * Throws AppException(INVALID_MEDIA_RANGE, 416) for malformed or unsatisfiable ranges.
 */
export function parseRangeHeader(
  rangeHeader: string | undefined,
  fileSize: number,
): ParsedRange | null {
  if (!rangeHeader) {
    return null;
  }

  const match = RANGE_PATTERN.exec(rangeHeader.trim());
  if (!match) {
    throw invalidRange();
  }

  const [, startStr, endStr] = match;
  if (startStr === '' && endStr === '') {
    throw invalidRange();
  }

  let start: number;
  let end: number;

  if (startStr === '') {
    const suffixLength = parseInt(endStr, 10);
    start = Math.max(fileSize - suffixLength, 0);
    end = fileSize - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr === '' ? fileSize - 1 : parseInt(endStr, 10);
  }

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    start > end ||
    end >= fileSize
  ) {
    throw invalidRange();
  }

  return { start, end };
}

function invalidRange(): AppException {
  return new AppException(
    AppErrorCode.INVALID_MEDIA_RANGE,
    'Requested range is not satisfiable',
    HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
  );
}
