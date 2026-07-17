import { HttpStatus } from '@nestjs/common';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { parseRangeHeader } from './video-range.util';

describe('parseRangeHeader', () => {
  const fileSize = 1000;

  it('returns null when no Range header is supplied', () => {
    expect(parseRangeHeader(undefined, fileSize)).toBeNull();
  });

  it('parses a bounded range', () => {
    expect(parseRangeHeader('bytes=0-499', fileSize)).toEqual({
      start: 0,
      end: 499,
    });
  });

  it('parses an open-ended range', () => {
    expect(parseRangeHeader('bytes=500-', fileSize)).toEqual({
      start: 500,
      end: 999,
    });
  });

  it('parses a suffix range', () => {
    expect(parseRangeHeader('bytes=-100', fileSize)).toEqual({
      start: 900,
      end: 999,
    });
  });

  it('throws INVALID_MEDIA_RANGE for a malformed header', () => {
    let caught: unknown;
    try {
      parseRangeHeader('not-a-range', fileSize);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppException);
    expect((caught as AppException).code).toBe(
      AppErrorCode.INVALID_MEDIA_RANGE,
    );
    expect((caught as AppException).getStatus()).toBe(
      HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
    );
  });

  it('throws when the range start exceeds the end', () => {
    expect(() => parseRangeHeader('bytes=500-100', fileSize)).toThrow(
      AppException,
    );
  });

  it('throws when the range extends beyond the file size', () => {
    expect(() => parseRangeHeader('bytes=0-1000', fileSize)).toThrow(
      AppException,
    );
  });

  it('throws for an empty bytes= header', () => {
    expect(() => parseRangeHeader('bytes=-', fileSize)).toThrow(AppException);
  });
});
