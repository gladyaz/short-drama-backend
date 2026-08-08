import { HttpStatus } from '@nestjs/common';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { resolvePlaybackSource } from './playback-source.util';

describe('resolvePlaybackSource (Phase 11, work unit 11M-B1)', () => {
  it('resolves to R2 when objectStorageKey is set and storageKey is empty', () => {
    const source = resolvePlaybackSource({
      storageKey: '',
      objectStorageKey: 'r2/series/episode-01.mp4',
    });

    expect(source).toEqual({
      kind: 'r2',
      objectStorageKey: 'r2/series/episode-01.mp4',
    });
  });

  it('resolves to local when storageKey is set and objectStorageKey is null', () => {
    const source = resolvePlaybackSource({
      storageKey: 'series/episode-01.mp4',
      objectStorageKey: null,
    });

    expect(source).toEqual({ kind: 'local' });
  });

  it('resolves to local when storageKey is set and objectStorageKey is an empty string', () => {
    const source = resolvePlaybackSource({
      storageKey: 'series/episode-01.mp4',
      objectStorageKey: '',
    });

    expect(source).toEqual({ kind: 'local' });
  });

  it('prefers R2 when BOTH storageKey and objectStorageKey are set', () => {
    const source = resolvePlaybackSource({
      storageKey: 'series/episode-01.mp4',
      objectStorageKey: 'r2/series/episode-01.mp4',
    });

    expect(source).toEqual({
      kind: 'r2',
      objectStorageKey: 'r2/series/episode-01.mp4',
    });
  });

  it('fails closed (throws MEDIA_PLAYBACK_SOURCE_UNAVAILABLE) when neither is set — both empty', () => {
    let caught: unknown;
    try {
      resolvePlaybackSource({ storageKey: '', objectStorageKey: null });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppException);
    expect((caught as AppException).code).toBe(
      AppErrorCode.MEDIA_PLAYBACK_SOURCE_UNAVAILABLE,
    );
    expect((caught as AppException).getStatus()).toBe(HttpStatus.CONFLICT);
  });

  it('fails closed when objectStorageKey is an empty string and storageKey is also empty', () => {
    expect(() =>
      resolvePlaybackSource({ storageKey: '', objectStorageKey: '' }),
    ).toThrow(AppException);
  });

  it('never leaks a bucket/endpoint/key value in the thrown error message', () => {
    let caught: unknown;
    try {
      resolvePlaybackSource({ storageKey: '', objectStorageKey: null });
    } catch (error) {
      caught = error;
    }

    expect((caught as AppException).message).not.toMatch(
      /bucket|endpoint|r2\.|amazonaws/i,
    );
  });
});
