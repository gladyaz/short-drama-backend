import { parseMigrationArgs } from './run-r2-media-migration-cli';

/**
 * Work unit "R2 MEDIA MIGRATION": argument parsing. The property that
 * matters most is the FIRST test — a bare invocation must never select a
 * writing mode.
 */
describe('parseMigrationArgs', () => {
  /** argv as Node hands it over: [execPath, scriptPath, ...args]. */
  const argv = (...args: string[]): string[] => ['node', 'script.js', ...args];

  it('defaults to read-only inventory when no flag is passed', () => {
    expect(parseMigrationArgs(argv()).options).toEqual({
      mode: 'inventory',
      checkRemote: false,
      limit: undefined,
      onlyVideoIds: undefined,
    });
  });

  it.each([
    ['--upload', 'upload'],
    ['--verify', 'verify'],
    ['--link', 'link'],
  ])(
    'selects %s -> %s only when that flag is given explicitly',
    (flag, mode) => {
      expect(parseMigrationArgs(argv(flag)).options.mode).toBe(mode);
    },
  );

  it('refuses two writing flags at once rather than silently picking one', () => {
    expect(() => parseMigrationArgs(argv('--upload', '--link'))).toThrow(
      /at most one of --upload, --verify, --link/,
    );
  });

  it('treats --check-remote as a modifier, not a mode', () => {
    const { options } = parseMigrationArgs(argv('--check-remote'));

    expect(options.mode).toBe('inventory');
    expect(options.checkRemote).toBe(true);
  });

  it('parses --limit=N', () => {
    expect(parseMigrationArgs(argv('--limit=5')).options.limit).toBe(5);
  });

  it.each(['--limit=0', '--limit=-3', '--limit=abc', '--limit=1.5'])(
    'rejects the malformed bound %p instead of falling back to a default',
    (bad) => {
      expect(() => parseMigrationArgs(argv(bad))).toThrow(
        /--limit must be a positive integer/,
      );
    },
  );

  it('rejects an unknown argument rather than ignoring a probable typo', () => {
    expect(() => parseMigrationArgs(argv('--uplaod'))).toThrow(
      /Unknown argument: --uplaod/,
    );
  });
  /**
   * `--only` exists because `--limit` cannot express "these specific
   * episodes": rows come back in curated feed order, so any bounded run takes
   * a PREFIX of that order. Requesting five episodes of a series that sits
   * third in the feed would otherwise drag in the twenty rows ahead of it —
   * the exact accident a controlled wave has to make impossible.
   */
  describe('--only', () => {
    it('parses a comma-separated id list', () => {
      expect(
        parseMigrationArgs(argv('--only=video-101-01,video-101-02')).options
          .onlyVideoIds,
      ).toEqual(['video-101-01', 'video-101-02']);
    });

    it('trims surrounding whitespace around each id', () => {
      expect(
        parseMigrationArgs(argv('--only= video-101-01 , video-101-02 ')).options
          .onlyVideoIds,
      ).toEqual(['video-101-01', 'video-101-02']);
    });

    it('is undefined when not passed, so an unfiltered run stays unfiltered', () => {
      expect(parseMigrationArgs(argv()).options.onlyVideoIds).toBeUndefined();
    });

    /**
     * The dangerous case: `--only=$IDS` with an unset shell variable expands
     * to `--only=`. Treating that as "no filter" would widen the run to EVERY
     * eligible row — the precise opposite of what was typed.
     */
    it('rejects an empty list rather than silently widening the run to every row', () => {
      expect(() => parseMigrationArgs(argv('--only='))).toThrow(
        /--only must name at least one video id/,
      );
      expect(() => parseMigrationArgs(argv('--only= , ,'))).toThrow(
        /--only must name at least one video id/,
      );
    });

    it('rejects duplicate ids instead of processing one twice', () => {
      expect(() =>
        parseMigrationArgs(argv('--only=video-101-01,video-101-01')),
      ).toThrow(/duplicate id\(s\): video-101-01/);
    });

    it('composes with a writing mode and a limit', () => {
      const { options } = parseMigrationArgs(
        argv('--upload', '--limit=5', '--only=video-101-01'),
      );

      expect(options.mode).toBe('upload');
      expect(options.limit).toBe(5);
      expect(options.onlyVideoIds).toEqual(['video-101-01']);
    });
  });
});
