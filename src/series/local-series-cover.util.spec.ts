import { join, resolve, sep } from 'path';
import {
  COVER_MAGIC_BYTE_LENGTH,
  resolveLocalCoverPath,
  sniffSeriesCoverContentType,
} from './local-series-cover.util';
import { buildSeriesCoverObjectKey } from './series-cover-key.util';

/**
 * Work unit "LOCAL SERIES COVER ARTWORK": the two properties the public,
 * unauthenticated cover route rests on — a key can never resolve outside the
 * local object root, and only bytes that ARE a permitted image format get a
 * `Content-Type`.
 */
describe('resolveLocalCoverPath', () => {
  const ROOT = '/srv/local-objects';

  it('resolves a well-formed cover key underneath the root', () => {
    const key = 'admin-series/series-104/cover/abc';

    expect(resolveLocalCoverPath(ROOT, key)).toBe(join(ROOT, key));
  });

  it('resolves every key this repo actually mints, for any series id', () => {
    for (const seriesId of ['series-104', 'series-010', 'a', 'x'.repeat(200)]) {
      const key = buildSeriesCoverObjectKey(seriesId);
      const resolved = resolveLocalCoverPath(ROOT, key);

      expect(resolved).not.toBeNull();
      expect(resolved!.startsWith(resolve(ROOT) + sep)).toBe(true);
    }
  });

  /**
   * The keys below cannot be produced by `buildSeriesCoverObjectKey` and
   * cannot pass `isValidSeriesCoverObjectKey`, so the route rejects them
   * before this function is reached. They are tested anyway: this guard is
   * the LAST line, and its value is precisely that it holds when the earlier
   * ones are bypassed or later loosened.
   */
  it.each([
    ['parent traversal', '../../../etc/passwd'],
    [
      'traversal after a valid-looking prefix',
      'admin-series/../../../etc/passwd',
    ],
    ['deep traversal', 'admin-series/x/cover/../../../../../../etc/passwd'],
    ['absolute path', '/etc/passwd'],
    [
      'absolute path to company media',
      '/Users/someone/dracin-subsindo/video.mp4',
    ],
    ['bare parent', '..'],
    ['the root itself', ''],
    ['a sibling directory sharing a name prefix', '../local-objects-other/x'],
  ])('refuses to escape the root: %s', (_label, key) => {
    expect(resolveLocalCoverPath(ROOT, key)).toBeNull();
  });

  it('cannot be tricked by a root given with a trailing separator', () => {
    expect(resolveLocalCoverPath(`${ROOT}/`, '../secret')).toBeNull();
  });
});

describe('sniffSeriesCoverContentType', () => {
  const header = (...bytes: number[]): Buffer =>
    Buffer.concat([
      Buffer.from(bytes),
      Buffer.alloc(Math.max(0, COVER_MAGIC_BYTE_LENGTH - bytes.length)),
    ]);

  it('identifies a JPEG', () => {
    expect(sniffSeriesCoverContentType(header(0xff, 0xd8, 0xff, 0xe0))).toBe(
      'image/jpeg',
    );
  });

  it('identifies a PNG', () => {
    expect(
      sniffSeriesCoverContentType(
        header(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      ),
    ).toBe('image/png');
  });

  it('identifies a WebP', () => {
    const webp = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from('WEBP', 'latin1'),
    ]);

    expect(sniffSeriesCoverContentType(webp)).toBe('image/webp');
  });

  /**
   * `RIFF` alone is also WAV and AVI. Serving either as an image would be a
   * content-type lie, and the form-type check is the only thing preventing it.
   */
  it('rejects a RIFF container that is not WebP', () => {
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE', 'latin1'),
    ]);

    expect(sniffSeriesCoverContentType(wav)).toBeNull();
  });

  it.each([
    [
      'an SVG, which the cover allow-list excludes outright',
      '<svg xmlns="http',
    ],
    ['HTML', '<!DOCTYPE html'],
    ['a GIF, a real image format that is still not allowed', 'GIF89a......'],
    ['arbitrary text', 'not an image'],
  ])('refuses to type %s', (_label, text) => {
    expect(sniffSeriesCoverContentType(Buffer.from(text, 'latin1'))).toBeNull();
  });

  it('refuses a truncated file rather than guessing from a partial match', () => {
    // The first two bytes of the PNG signature, and nothing more.
    expect(sniffSeriesCoverContentType(Buffer.from([0x89, 0x50]))).toBeNull();
  });

  it('refuses an empty file', () => {
    expect(sniffSeriesCoverContentType(Buffer.alloc(0))).toBeNull();
  });
});
