import { describe, expect, it } from 'vitest';
import { resolveContentType } from '../src/content-type';

describe('resolveContentType', () => {
  it('maps .m3u8 to application/vnd.apple.mpegurl', () => {
    expect(resolveContentType('master.m3u8')).toBe(
      'application/vnd.apple.mpegurl',
    );
    expect(resolveContentType('360p/index.m3u8')).toBe(
      'application/vnd.apple.mpegurl',
    );
  });

  it('maps init.mp4 and any other .mp4 to video/mp4', () => {
    expect(resolveContentType('360p/init.mp4')).toBe('video/mp4');
    expect(resolveContentType('source.mp4')).toBe('video/mp4');
  });

  it('maps .m4s to video/iso.segment', () => {
    expect(resolveContentType('360p/seg_00001.m4s')).toBe('video/iso.segment');
  });

  it('maps .jpg to image/jpeg', () => {
    expect(resolveContentType('poster.jpg')).toBe('image/jpeg');
  });

  it('falls back to application/octet-stream for anything else', () => {
    expect(resolveContentType('README.txt')).toBe('application/octet-stream');
    expect(resolveContentType('no-extension')).toBe('application/octet-stream');
  });

  it('is case-insensitive', () => {
    expect(resolveContentType('MASTER.M3U8')).toBe(
      'application/vnd.apple.mpegurl',
    );
  });
});
