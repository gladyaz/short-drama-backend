import { describe, expect, it } from 'vitest';
import { buildObjectKey, normalizeRelativePath } from '../src/path';

describe('normalizeRelativePath (Slice 11Q, load-bearing path security)', () => {
  it('accepts a clean a/b/c.ext relative path unchanged', () => {
    expect(normalizeRelativePath('360p/index.m3u8')).toBe('360p/index.m3u8');
    expect(normalizeRelativePath('master.m3u8')).toBe('master.m3u8');
    expect(normalizeRelativePath('720p/seg_00001.m4s')).toBe(
      '720p/seg_00001.m4s',
    );
  });

  it('[TEST 7] rejects literal ".." traversal', () => {
    expect(normalizeRelativePath('../secret.mp4')).toBeNull();
    expect(normalizeRelativePath('360p/../../etc/passwd')).toBeNull();
    expect(normalizeRelativePath('..')).toBeNull();
  });

  it('rejects a bare "." component', () => {
    expect(normalizeRelativePath('./master.m3u8')).toBeNull();
    expect(normalizeRelativePath('360p/./index.m3u8')).toBeNull();
  });

  it('rejects any pure-dots component beyond "." and ".." (reviewer-recommended defense-in-depth, fix cycle 1)', () => {
    expect(normalizeRelativePath('.../master.m3u8')).toBeNull();
    expect(normalizeRelativePath('..../master.m3u8')).toBeNull();
    expect(normalizeRelativePath('360p/.../index.m3u8')).toBeNull();
  });

  it('rejects an empty component (double slash)', () => {
    expect(normalizeRelativePath('360p//index.m3u8')).toBeNull();
  });

  it('rejects a leading "/" (must be relative, never absolute)', () => {
    expect(normalizeRelativePath('/master.m3u8')).toBeNull();
    expect(normalizeRelativePath('//etc/passwd')).toBeNull();
  });

  it('rejects any backslash', () => {
    expect(normalizeRelativePath('360p\\index.m3u8')).toBeNull();
    expect(normalizeRelativePath('..\\..\\secret.mp4')).toBeNull();
  });

  it('rejects null bytes and control characters', () => {
    expect(normalizeRelativePath('master.m3u8\u0000')).toBeNull();
    expect(normalizeRelativePath('mas\u0001ter.m3u8')).toBeNull();
  });

  it('[TEST 8] rejects single percent-encoded traversal (%2e%2e%2f)', () => {
    expect(normalizeRelativePath('%2e%2e%2fsecret.mp4')).toBeNull();
    expect(normalizeRelativePath('%2E%2E%2Fsecret.mp4')).toBeNull(); // case-insensitive
  });

  it('[TEST 8] rejects an encoded leading slash (%2f)', () => {
    expect(normalizeRelativePath('%2fmaster.m3u8')).toBeNull();
  });

  it('[TEST 8] rejects an encoded backslash (%5c)', () => {
    expect(normalizeRelativePath('%5c%5csecret.mp4')).toBeNull();
  });

  it('[TEST 8] rejects DOUBLE-encoded traversal (%252e%252e%252f survives ONE decode as literal %2e%2e%2f)', () => {
    expect(normalizeRelativePath('%252e%252e%252fsecret.mp4')).toBeNull();
  });

  it('[TEST 8] rejects a Unicode fullwidth-solidus trick (NFC does not fold it to ASCII "/", and the character allowlist rejects it outright either way)', () => {
    // U+FF0F FULLWIDTH SOLIDUS
    expect(normalizeRelativePath('360p／..／secret.mp4')).toBeNull();
  });

  it('rejects a percent-decode failure (malformed escape)', () => {
    expect(normalizeRelativePath('%zz')).toBeNull();
    expect(normalizeRelativePath('100%')).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(normalizeRelativePath('')).toBeNull();
  });

  it('rejects a path containing a raw space or other disallowed character', () => {
    expect(normalizeRelativePath('has space.mp4')).toBeNull();
    expect(normalizeRelativePath('semi;colon.mp4')).toBeNull();
  });

  it('accepts a percent-encoded but otherwise harmless character within the allowlist (e.g. an encoded dash decodes to a literal dash, still allowed)', () => {
    expect(normalizeRelativePath('seg%2D00001.m4s')).toBe('seg-00001.m4s');
  });
});

describe('buildObjectKey', () => {
  const prefix = 'admin-media/video-abc/hls/v1-a1-uuid/';

  it('concatenates prefix + relative path', () => {
    expect(buildObjectKey(prefix, 'master.m3u8')).toBe(
      'admin-media/video-abc/hls/v1-a1-uuid/master.m3u8',
    );
  });

  it('returns null for an empty prefix', () => {
    expect(buildObjectKey('', 'master.m3u8')).toBeNull();
  });

  it('returns null for an empty relative path', () => {
    expect(buildObjectKey(prefix, '')).toBeNull();
  });
});
