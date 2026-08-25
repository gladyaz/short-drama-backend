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
});
