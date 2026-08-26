import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HlsDemoteCliModule } from './hls-demote-cli.module';
import { HlsDemoteService } from './hls-demote.service';
import { HlsDemotePlaybackOutcome, HlsDemoteReport } from './hls-demote.types';

/**
 * Work unit "HLS DEMOTE": the implementation behind `scripts/hls-demote.ts`
 * (`npm run hls:demote`).
 *
 * Lives under `src/` rather than in the `scripts/` entry file for exactly the
 * reason `run-series-cover-orphans-cli.ts` and `run-retention-cli.ts` do:
 * this repo's Jest `rootDir` is `src`, so only a file here can have a normal
 * `*.spec.ts` beside it. The `scripts/` file stays a thin entry point that
 * loads `.env` and calls this.
 *
 * ## Dry run is the default
 *
 * With no `--apply`, this reports what WOULD stop being advertised and writes
 * nothing — `HlsDemoteService.run` cannot reach its guarded `updateMany`
 * without `apply: true`. The report is identical either way, so an operator
 * compares the dry run's output to the applied run's output line for line.
 *
 * ## Exit codes
 *
 * `0` only when the command did what was asked: a dry run whose every safety
 * gate passed, or an `--apply` run whose guarded write landed. ANY refusal —
 * including a dry run that would refuse — exits `1`, so the dry run is usable
 * as a gate without parsing its output.
 */

export interface HlsDemoteArgs {
  videoId: string;
  expectedGeneration: number;
  apply: boolean;
  allowUnplayable: boolean;
  help: boolean;
}

export interface RunHlsDemoteCliDeps {
  /**
   * Defaults to booting `HlsDemoteCliModule`. Kept as an injectable factory
   * so the spec can assert, by construction, that it was NEVER invoked for a
   * `--help` or an argument-validation failure.
   */
  createContext: () => Promise<INestApplicationContext>;
  /** Defaults to `console.log`, matching this repo's other CLIs' plain-stdout convention. */
  log: (message: string) => void;
}

const defaultDeps: RunHlsDemoteCliDeps = {
  createContext: () =>
    NestFactory.createApplicationContext(HlsDemoteCliModule, {
      // Quieter than `run-series-cover-orphans-cli.ts`'s `['error','warn','log']`:
      // this command's whole output IS its report, and Nest's boot chatter
      // between the header and the plan makes that report harder to read.
      logger: ['warn', 'error'],
    }),
  // `no-console` is not an active ESLint rule in this repo (see
  // `eslint.config.mjs`); like the retention and cover-orphan CLIs, this
  // tool's report is deliberately plain human-readable stdout.
  log: (message: string) => {
    console.log(message);
  },
};

/**
 * A `Video.id` this command is willing to act on: a conservative allowlist,
 * NOT a blocklist. Anything with a slash, a wildcard, a percent-escape or
 * whitespace is refused before a database connection is even opened — this
 * command addresses exactly one row by primary key and has no legitimate use
 * for a pattern.
 */
const SAFE_VIDEO_ID = /^[A-Za-z0-9._-]{1,200}$/;

/** The only two flags that take a value. Everything else is a bare boolean flag or an error. */
const FLAGS_WITH_VALUES = ['--video-id', '--generation'] as const;

export const HLS_DEMOTE_USAGE = [
  'Usage:',
  '  npm run hls:demote -- --video-id <id> --generation <processingVersion> [--apply] [--allow-unplayable]',
  '',
  'Stops ONE video advertising ONE currently-live HLS generation.',
  'There is no rollback-to-previous: no previous generation is recorded',
  'anywhere in this schema. See docs/HLS_TRANSCODE_WAVE.md §8.',
  '',
  'Options:',
  '  --video-id <id>       Required. The exact Video.id. No patterns, no wildcards.',
  '  --generation <n>      Required. The Video.processingVersion you expect to be live.',
  '                        A mismatch refuses without writing anything.',
  '  --apply               Perform the demotion. WITHOUT THIS FLAG NOTHING IS WRITTEN.',
  '  --allow-unplayable    Permit demoting a row that would be left with no playable',
  '                        source at all (409 on /playback). Refused by default.',
  '  --help                Print this and exit 0.',
  '',
  'Storage is never deleted by this command, and the source MP4 is never touched.',
].join('\n');

/**
 * Pure argument parsing, exported so its rejections are directly testable.
 * Accepts both `--flag=value` and `--flag value`. Throws on anything it does
 * not fully understand — an unrecognised flag is an error rather than a
 * silent no-op, so a typo can never quietly change what the command does.
 */
export function parseHlsDemoteArgs(argv: readonly string[]): HlsDemoteArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return {
      videoId: '',
      expectedGeneration: 0,
      apply: false,
      allowUnplayable: false,
      help: true,
    };
  }

  let videoId: string | undefined;
  let generationRaw: string | undefined;
  let apply = false;
  let allowUnplayable = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--allow-unplayable') {
      allowUnplayable = true;
      continue;
    }

    const flag = FLAGS_WITH_VALUES.find(
      (candidate) => arg === candidate || arg.startsWith(`${candidate}=`),
    );

    if (!flag) {
      throw new Error(`Unrecognised argument "${arg}".\n\n${HLS_DEMOTE_USAGE}`);
    }

    const inline = arg.startsWith(`${flag}=`);
    const value = inline ? arg.slice(flag.length + 1) : argv[index + 1];

    if (value === undefined || (!inline && value.startsWith('--'))) {
      throw new Error(`${flag} requires a value.\n\n${HLS_DEMOTE_USAGE}`);
    }
    if (!inline) {
      index += 1;
    }

    if (flag === '--video-id') {
      videoId = value;
    } else {
      generationRaw = value;
    }
  }

  if (!videoId) {
    throw new Error(`--video-id is required.\n\n${HLS_DEMOTE_USAGE}`);
  }
  if (!SAFE_VIDEO_ID.test(videoId)) {
    throw new Error(
      `--video-id ${JSON.stringify(videoId)} is not a plain Video id. This ` +
        'command addresses exactly one row by primary key; patterns, ' +
        'wildcards and paths are refused.',
    );
  }
  if (generationRaw === undefined) {
    throw new Error(`--generation is required.\n\n${HLS_DEMOTE_USAGE}`);
  }
  if (!/^\d+$/.test(generationRaw)) {
    throw new Error(
      `--generation ${JSON.stringify(generationRaw)} is not a non-negative ` +
        'integer. It is the Video.processingVersion you expect to be live.',
    );
  }

  return {
    videoId,
    expectedGeneration: Number(generationRaw),
    apply,
    allowUnplayable,
    help: false,
  };
}

/** Resolves with the process exit code. Never calls `process.exit` itself. */
export async function runHlsDemoteCli(
  argv: string[],
  deps: RunHlsDemoteCliDeps = defaultDeps,
): Promise<number> {
  const args = parseHlsDemoteArgs(argv);

  if (args.help) {
    deps.log(HLS_DEMOTE_USAGE);
    return 0;
  }

  const context = await deps.createContext();

  try {
    const service = context.get(HlsDemoteService);
    const report = await service.run({
      videoId: args.videoId,
      expectedGeneration: args.expectedGeneration,
      apply: args.apply,
      allowUnplayable: args.allowUnplayable,
    });

    printReport(report, deps.log);
    return report.refusal ? 1 : 0;
  } finally {
    await context.close();
  }
}

/**
 * Prints KEYS ONLY — never a presigned URL, never a bucket credential, never
 * an endpoint (same rule `run-series-cover-orphans-cli.ts` prints under: a
 * key identifies an object, it does not authorize access to one).
 */
function printReport(
  report: HlsDemoteReport,
  log: (message: string) => void,
): void {
  log(
    report.apply
      ? 'HLS DEMOTE — APPLY (the database was written)'
      : 'HLS DEMOTE — DRY RUN (report only, nothing was written)',
  );
  log(`Generated at:        ${report.generatedAt.toISOString()}`);
  log(`Target video:        ${report.videoId}`);
  log(`Expected generation: v${report.expectedGeneration}`);
  log('');

  if (report.current) {
    log('Current database state:');
    log(
      `  processingState:         ${report.current.processingState ?? 'null'}`,
    );
    log(`  processingVersion:       ${report.current.processingVersion}`);
    log(`  lifecycleState:          ${report.current.lifecycleState}`);
    log(`  hlsMasterKey:            ${report.current.hlsMasterKey ?? 'null'}`);
    log(
      `  transcodeProfileVersion: ${report.current.transcodeProfileVersion ?? 'null'}`,
    );
    log(
      `  objectStorageKey:        ${report.current.objectStorageKey ?? 'null'}`,
    );
    log(
      `  storageKey:              ${report.current.storageKey === '' ? '(empty)' : report.current.storageKey}`,
    );
    log('');
  }

  if (report.plan) {
    log('Would stop advertising:');
    log(`  master playlist:   ${report.plan.masterKey}`);
    log(`  generation prefix: ${report.plan.generationPrefix}`);
    if (report.plan.renditions.length === 0) {
      log('  renditions:        (none recorded on the row)');
    } else {
      for (const rendition of report.plan.renditions) {
        log(
          `  rendition:         ${rendition.name} ${rendition.width}x${rendition.height}`,
        );
      }
    }
    log('');

    log(
      'Objects left completely untouched (nothing is deleted by this command):',
    );
    for (const key of report.plan.untouchedObjects) {
      log(`  ${key}`);
    }
    log(
      `  ${report.plan.generationPrefix}* — the demoted generation's own objects`,
    );
    log('');

    log(
      `Resulting playback: ${describePlayback(report.plan.resultingPlayback)}`,
    );
    log('');
  }

  if (report.refusal) {
    log(`REFUSED (${report.refusal.code}): ${report.refusal.detail}`);
    log('NOTHING was written.');
    return;
  }

  if (report.demoted) {
    log('DEMOTED. GET /videos/:id/playback no longer returns the HLS shape.');
    log(
      'Already-minted playback tokens stay valid until they expire ' +
        '(HLS_TOKEN_TTL_SECONDS) — the gateway is stateless and does not ' +
        'consult the database.',
    );
    return;
  }

  log(
    'This was a DRY RUN. Nothing was written. Re-run with --apply to perform ' +
      'the demotion shown above.',
  );
}

function describePlayback(outcome: HlsDemotePlaybackOutcome): string {
  switch (outcome.kind) {
    case 'r2':
      return (
        `presigned R2 MP4 from ${outcome.objectStorageKey} ` +
        `(object present: ${outcome.sourceObjectPresent ? 'yes' : 'NO'})`
      );
    case 'local':
      return `local /videos/:id/stream from storageKey ${outcome.storageKey}`;
    case 'unavailable':
      return 'UNAVAILABLE — 409 MEDIA_PLAYBACK_SOURCE_UNAVAILABLE (no source on the row)';
  }
}
