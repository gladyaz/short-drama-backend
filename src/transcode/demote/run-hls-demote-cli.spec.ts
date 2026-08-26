import { INestApplicationContext } from '@nestjs/common';
import { HlsDemoteService } from './hls-demote.service';
import { HlsDemoteReport } from './hls-demote.types';
import {
  HLS_DEMOTE_USAGE,
  parseHlsDemoteArgs,
  runHlsDemoteCli,
} from './run-hls-demote-cli';

/**
 * Work unit "HLS DEMOTE": the CLI's own contract — argument validation, the
 * dry-run default, the exit code, and the ordering guarantee that a bad
 * argument list never reaches a database connection. `HlsDemoteService` is
 * mocked wholesale; its behavior is proven in `hls-demote.service.spec.ts`
 * against a real database.
 */
describe('parseHlsDemoteArgs', () => {
  it('parses the space-separated form', () => {
    expect(
      parseHlsDemoteArgs(['--video-id', 'video-101-01', '--generation', '3']),
    ).toEqual({
      videoId: 'video-101-01',
      expectedGeneration: 3,
      apply: false,
      allowUnplayable: false,
      help: false,
    });
  });

  it('parses the equals form identically', () => {
    expect(
      parseHlsDemoteArgs(['--video-id=video-101-01', '--generation=3']),
    ).toEqual(
      parseHlsDemoteArgs(['--video-id', 'video-101-01', '--generation', '3']),
    );
  });

  it('defaults to a DRY RUN — apply is opt-in', () => {
    const args = parseHlsDemoteArgs(['--video-id=v', '--generation=1']);

    expect(args.apply).toBe(false);
  });

  it('reads --apply and --allow-unplayable', () => {
    const args = parseHlsDemoteArgs([
      '--video-id=v',
      '--generation=1',
      '--apply',
      '--allow-unplayable',
    ]);

    expect(args.apply).toBe(true);
    expect(args.allowUnplayable).toBe(true);
  });

  it('treats --help as terminal, before any other validation', () => {
    expect(parseHlsDemoteArgs(['--help']).help).toBe(true);
    expect(parseHlsDemoteArgs(['-h']).help).toBe(true);
  });

  it.each([
    [[], '--video-id is required'],
    [['--generation=3'], '--video-id is required'],
    [['--video-id=v'], '--generation is required'],
    [['--video-id'], '--video-id requires a value'],
    [['--video-id', '--apply'], '--video-id requires a value'],
    [['--video-id=v', '--generation=abc'], 'not a non-negative integer'],
    [['--video-id=v', '--generation=-1'], 'not a non-negative integer'],
    [['--video-id=v', '--generation=1.5'], 'not a non-negative integer'],
    [['--video-id=v', '--generation=3', '--aply'], 'Unrecognised argument'],
  ])('rejects %j', (argv, expectedMessage) => {
    expect(() => parseHlsDemoteArgs(argv)).toThrow(expectedMessage);
  });

  it.each([
    ['*'],
    ['video-101-*'],
    ['admin-media/video-101-01'],
    ['../video-101-01'],
    ['%'],
    ['video 101'],
    [''],
  ])('refuses the broad/unsafe target %j', (videoId) => {
    expect(() =>
      parseHlsDemoteArgs([`--video-id=${videoId}`, '--generation=1']),
    ).toThrow();
  });

  it('accepts the real catalog id shape', () => {
    expect(
      parseHlsDemoteArgs(['--video-id=video-101-01', '--generation=0'])
        .expectedGeneration,
    ).toBe(0);
  });
});

describe('runHlsDemoteCli', () => {
  let logged: string[];
  let closed: boolean;
  let run: jest.Mock;
  let createContext: jest.Mock;

  function buildReport(
    overrides: Partial<HlsDemoteReport> = {},
  ): HlsDemoteReport {
    return {
      generatedAt: new Date('2026-08-26T00:00:00.000Z'),
      apply: false,
      videoId: 'video-101-01',
      expectedGeneration: 3,
      allowUnplayable: false,
      demoted: false,
      current: {
        processingState: 'ready',
        processingVersion: 3,
        hlsMasterKey: 'admin-media/video-101-01/hls/v3-a1-uuid/master.m3u8',
        transcodeProfileVersion: 'ladder-v1',
        lifecycleState: 'published',
        renditions: [{ name: '360p', width: 360, height: 640 }],
        objectStorageKey: 'admin-media/video-101-01/source',
        storageKey: '',
      },
      plan: {
        masterKey: 'admin-media/video-101-01/hls/v3-a1-uuid/master.m3u8',
        generationPrefix: 'admin-media/video-101-01/hls/v3-a1-uuid/',
        renditions: [{ name: '360p', width: 360, height: 640 }],
        untouchedObjects: ['admin-media/video-101-01/source'],
        resultingPlayback: {
          kind: 'r2',
          objectStorageKey: 'admin-media/video-101-01/source',
          sourceObjectPresent: true,
        },
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    logged = [];
    closed = false;
    run = jest.fn().mockResolvedValue(buildReport());
    createContext = jest.fn().mockResolvedValue({
      get: (token: unknown) =>
        token === HlsDemoteService ? { run } : undefined,
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    });
  });

  const deps = () => ({
    createContext:
      createContext as unknown as () => Promise<INestApplicationContext>,
    log: (message: string) => logged.push(message),
  });

  it('--help prints the usage and never opens a database connection', async () => {
    const exitCode = await runHlsDemoteCli(['--help'], deps());

    expect(exitCode).toBe(0);
    expect(logged.join('\n')).toContain(HLS_DEMOTE_USAGE);
    expect(createContext).not.toHaveBeenCalled();
  });

  it('an invalid argument list throws before any context is created', async () => {
    await expect(runHlsDemoteCli(['--video-id=v'], deps())).rejects.toThrow(
      '--generation is required',
    );

    expect(createContext).not.toHaveBeenCalled();
  });

  it('passes apply:false by default and says so in the report header', async () => {
    const exitCode = await runHlsDemoteCli(
      ['--video-id=video-101-01', '--generation=3'],
      deps(),
    );

    expect(run).toHaveBeenCalledWith({
      videoId: 'video-101-01',
      expectedGeneration: 3,
      apply: false,
      allowUnplayable: false,
    });
    expect(exitCode).toBe(0);
    const output = logged.join('\n');
    expect(output).toContain('DRY RUN (report only, nothing was written)');
    expect(output).toContain('This was a DRY RUN. Nothing was written.');
  });

  it('prints the master key, generation prefix, renditions, untouched objects and resulting playback', async () => {
    await runHlsDemoteCli(
      ['--video-id=video-101-01', '--generation=3'],
      deps(),
    );

    const output = logged.join('\n');
    expect(output).toContain(
      'admin-media/video-101-01/hls/v3-a1-uuid/master.m3u8',
    );
    expect(output).toContain('admin-media/video-101-01/hls/v3-a1-uuid/');
    expect(output).toContain('360p 360x640');
    expect(output).toContain('admin-media/video-101-01/source');
    expect(output).toContain('Resulting playback: presigned R2 MP4');
    expect(output).toContain('nothing is deleted by this command');
  });

  it('passes apply:true through and reports the mutation', async () => {
    run.mockResolvedValue(buildReport({ apply: true, demoted: true }));

    const exitCode = await runHlsDemoteCli(
      ['--video-id=video-101-01', '--generation=3', '--apply'],
      deps(),
    );

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ apply: true, allowUnplayable: false }),
    );
    expect(exitCode).toBe(0);
    const output = logged.join('\n');
    expect(output).toContain('APPLY (the database was written)');
    expect(output).toContain('DEMOTED.');
    expect(output).toContain('Already-minted playback tokens stay valid');
  });

  it('exits non-zero on a refusal, including on a dry run, so it is usable as a gate', async () => {
    run.mockResolvedValue(
      buildReport({
        plan: undefined,
        refusal: {
          code: 'GENERATION_MISMATCH',
          detail: 'stale command',
        },
      }),
    );

    const exitCode = await runHlsDemoteCli(
      ['--video-id=video-101-01', '--generation=3'],
      deps(),
    );

    expect(exitCode).toBe(1);
    const output = logged.join('\n');
    expect(output).toContain('REFUSED (GENERATION_MISMATCH)');
    expect(output).toContain('NOTHING was written.');
  });

  it('reports an unavailable fallback truthfully rather than inventing an MP4', async () => {
    run.mockResolvedValue(
      buildReport({
        plan: {
          masterKey: 'admin-media/video-101-01/hls/v3-a1-uuid/master.m3u8',
          generationPrefix: 'admin-media/video-101-01/hls/v3-a1-uuid/',
          renditions: [],
          untouchedObjects: ['admin-media/video-101-01/source'],
          resultingPlayback: { kind: 'unavailable' },
        },
      }),
    );

    await runHlsDemoteCli(
      ['--video-id=video-101-01', '--generation=3'],
      deps(),
    );

    const output = logged.join('\n');
    expect(output).toContain('Resulting playback: UNAVAILABLE');
    expect(output).toContain('MEDIA_PLAYBACK_SOURCE_UNAVAILABLE');
    expect(output).toContain('renditions:        (none recorded on the row)');
  });

  it('always closes the Nest context, even when the service throws', async () => {
    run.mockRejectedValue(new Error('boom'));

    await expect(
      runHlsDemoteCli(['--video-id=video-101-01', '--generation=3'], deps()),
    ).rejects.toThrow('boom');

    expect(closed).toBe(true);
  });
});
