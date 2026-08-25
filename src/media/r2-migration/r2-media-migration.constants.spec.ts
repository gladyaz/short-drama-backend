import {
  MIGRATION_MAX_SOURCE_BYTES,
  buildMigrationObjectKey,
} from './r2-media-migration.constants';

/**
 * Work unit "R2 MEDIA MIGRATION": the destination-key rule is the single
 * most load-bearing decision in this migration — get it wrong and two rows
 * overwrite each other's media in a bucket. These are pure-function tests:
 * no database, no network, no filesystem.
 */
describe('buildMigrationObjectKey', () => {
  it('matches the admin-media/<id>/source convention the existing QA-fixture rows already use', () => {
    expect(buildMigrationObjectKey('media-11rqa-8ac6a7f3')).toBe(
      'admin-media/media-11rqa-8ac6a7f3/source',
    );
  });

  it('is deterministic — the same row id always yields the same key', () => {
    expect(buildMigrationObjectKey('video-104-01')).toBe(
      buildMigrationObjectKey('video-104-01'),
    );
  });

  it('is injective across the real catalog ids, so no two rows can collide', () => {
    const ids = ['104', '010', '101', '105'].flatMap((series) =>
      Array.from(
        { length: 10 },
        (_, i) => `video-${series}-${String(i + 1).padStart(2, '0')}`,
      ),
    );

    const keys = ids.map(buildMigrationObjectKey);

    expect(ids).toHaveLength(40);
    expect(new Set(keys).size).toBe(40);
  });

  it('produces an ASCII key even though four of the source FILENAMES are CJK', () => {
    // series-101's episodes are named 第1集_subtitled.mp4 … 第10集_subtitled.mp4.
    // The key is derived from the row id, so none of that reaches the bucket.
    const key = buildMigrationObjectKey('video-101-07');

    expect(key).toBe('admin-media/video-101-07/source');
    expect(/^[\x20-\x7e]+$/.test(key)).toBe(true);
  });

  it('bounds in-memory buffering well above the real catalog maximum (~45 MiB)', () => {
    expect(MIGRATION_MAX_SOURCE_BYTES).toBe(256 * 1024 * 1024);
    expect(MIGRATION_MAX_SOURCE_BYTES).toBeGreaterThan(45 * 1024 * 1024);
  });
});
