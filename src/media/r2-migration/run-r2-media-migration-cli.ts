import { NestFactory } from '@nestjs/core';
import { R2MediaMigrationCliModule } from './r2-media-migration-cli.module';
import {
  R2MediaMigrationService,
  type MigrationRunOptions,
} from './r2-media-migration.service';
import type { MigrationReport } from './r2-media-migration.types';

/**
 * Work unit "R2 MEDIA MIGRATION": argument parsing and human-readable
 * reporting for `scripts/run-r2-media-migration.ts`.
 *
 * MODE SELECTION IS EXPLICIT AND MUTUALLY EXCLUSIVE. Passing no flag runs
 * `inventory`, which writes nothing anywhere. Passing two writing flags at
 * once is an error rather than a silently-resolved precedence rule — an
 * operator who typed `--upload --link` meant to do two different things and
 * should be told the tool does one per invocation.
 */
export function parseMigrationArgs(argv: readonly string[]): {
  options: MigrationRunOptions;
} {
  const args = argv.slice(2);
  const known = new Set([
    '--upload',
    '--verify',
    '--link',
    '--check-remote',
    '--help',
  ]);

  for (const arg of args) {
    if (
      !known.has(arg) &&
      !arg.startsWith('--limit=') &&
      !arg.startsWith('--only=')
    ) {
      throw new Error(
        `Unknown argument: ${arg}. Valid: --upload | --verify | --link | --check-remote | --limit=N | --only=id1,id2`,
      );
    }
  }

  const selected = (['--upload', '--verify', '--link'] as const).filter((f) =>
    args.includes(f),
  );

  if (selected.length > 1) {
    throw new Error(
      `Pass at most one of --upload, --verify, --link (got ${selected.join(', ')}). ` +
        'Each is a separate step, run in that order.',
    );
  }

  const limitArg = args.find((a) => a.startsWith('--limit='));
  let limit: number | undefined;
  if (limitArg !== undefined) {
    const parsed = Number(limitArg.slice('--limit='.length));
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`--limit must be a positive integer (got ${limitArg}).`);
    }
    limit = parsed;
  }

  // `--only=a,b,c` restricts the run to exactly those Video ids. Parsed
  // strictly: an empty list is an error rather than a silent "no filter",
  // because `--only=` with a mistyped/expanded-to-nothing shell variable would
  // otherwise widen the run to EVERY eligible row — the opposite of intent.
  const onlyArg = args.find((a) => a.startsWith('--only='));
  let onlyVideoIds: string[] | undefined;
  if (onlyArg !== undefined) {
    onlyVideoIds = onlyArg
      .slice('--only='.length)
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    if (onlyVideoIds.length === 0) {
      throw new Error(
        '--only must name at least one video id (e.g. --only=video-101-01,video-101-02).',
      );
    }

    const duplicates = onlyVideoIds.filter(
      (id, index) => onlyVideoIds!.indexOf(id) !== index,
    );
    if (duplicates.length > 0) {
      throw new Error(
        `--only contains duplicate id(s): ${[...new Set(duplicates)].join(', ')}.`,
      );
    }
  }

  const mode: MigrationRunOptions['mode'] =
    selected[0] === '--upload'
      ? 'upload'
      : selected[0] === '--verify'
        ? 'verify'
        : selected[0] === '--link'
          ? 'link'
          : 'inventory';

  return {
    options: {
      mode,
      checkRemote: args.includes('--check-remote'),
      limit,
      onlyVideoIds,
    },
  };
}

/** Renders a report. Prints no credential — only bucket/object names and counts. */
export function formatMigrationReport(report: MigrationReport): string {
  const lines: string[] = [];
  lines.push(
    `mode=${report.mode}  ${report.dryRun ? 'DRY RUN (nothing written)' : 'WRITING'}`,
  );
  lines.push(`bucket=${report.bucket ?? '(unset)'}`);
  lines.push(`storageRoot=${report.storageRoot}`);
  lines.push(
    `rows: ${report.totalRowsConsidered} total, ${report.alreadyLinked} already linked, ${report.eligible} eligible`,
  );
  lines.push(`  ready=${report.ready}  blocked=${report.blocked}`);

  if (report.mode === 'upload') {
    lines.push(
      `  uploaded=${report.uploaded}  skipped(already present)=${report.skippedAlreadyUploaded}`,
    );
  }
  if (report.mode === 'verify' || report.mode === 'link') {
    lines.push(
      `  verifiedOk=${report.verifiedOk}  mismatch=${report.verifiedMismatch}`,
    );
  }
  if (report.mode === 'link') {
    lines.push(`  linked=${report.linked}`);
  }

  const blocked = report.candidates.filter((c) => c.blockedReason !== null);
  if (blocked.length > 0) {
    lines.push('', 'BLOCKED ROWS:');
    for (const c of blocked) {
      lines.push(
        `  ${c.videoId}  ${c.blockedReason}  storageKey=${c.storageKey}`,
      );
    }
  }

  if (report.mode === 'inventory') {
    lines.push('', 'PLANNED MAPPING:');
    for (const c of report.candidates) {
      const size = c.sourceBytes === null ? '?' : `${c.sourceBytes}B`;
      const remote =
        c.remoteExists === null
          ? ''
          : c.remoteExists
            ? `  [remote: present ${String(c.remoteBytes)}B]`
            : '  [remote: absent]';
      lines.push(
        `  ${c.videoId}  ${c.storageKey}  ->  ${c.objectKey}  (${size})${remote}`,
      );
    }
  }

  for (const warning of report.warnings) {
    lines.push(`WARNING: ${warning}`);
  }

  return lines.join('\n');
}

/**
 * Boots the standalone context, runs one mode, prints the report.
 *
 * EXIT STATUS IS MEANINGFUL. A run that found blocked rows, or that could
 * not verify an object it was asked to link, exits non-zero even though it
 * did not crash — so a `&&` chain or CI step cannot mistake "reported 12
 * missing source files" for success.
 */
export async function runR2MediaMigrationCli(
  argv: readonly string[],
): Promise<void> {
  const { options } = parseMigrationArgs(argv);

  const app = await NestFactory.createApplicationContext(
    R2MediaMigrationCliModule,
    { logger: ['error', 'warn', 'log'] },
  );

  try {
    const service = app.get(R2MediaMigrationService);
    const report = await service.run(options);

    // eslint-disable-next-line no-console
    console.log(formatMigrationReport(report));

    if (report.blocked > 0 || report.verifiedMismatch > 0) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}
