import type { Dirent, Stats } from 'fs';
import { readdir, stat } from 'fs/promises';
import { extname, join, relative } from 'path';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import {
  DEFAULT_DRYRUN_MAX_ATTEMPTS,
  SUPPORTED_DRYRUN_VIDEO_EXTENSIONS,
} from './dryrun.constants';
import type {
  DryRunItemResult,
  DryRunOptions,
  DryRunReport,
} from './dryrun.types';
import { FFPROBE_CLIENT } from './importer.types';
import type { FfprobeClient } from './importer.types';

/**
 * Phase 11, work unit 11D-1-dryrun: a strictly READ-ONLY companion to
 * `MediaImporterService` that inspects one explicitly-passed local folder
 * and reports what a real import WOULD do — without importing anything.
 *
 * - **No default path, ever.** `inspect()` takes `folderPath` as a required
 *   call argument; there is no fallback to `STORAGE_ROOT` or any other
 *   directory (see AGENT_RULES.md's hard prohibition on touching company
 *   video files, and DECISIONS.md's Slice #2 approval, which scopes this
 *   work unit to strictly read-only inspection of an explicitly-passed
 *   folder). A missing/empty path always throws, never silently defaults.
 * - **No `PrismaService` dependency at all** — not injected, not imported.
 *   Structurally, this class cannot read or write the database. Contrast
 *   with `MediaImporterService`, the real DB-writing importer this dry-run
 *   only *simulates* the outcome of.
 * - **No writes of any kind.** The only filesystem calls this file makes
 *   are `fs/promises`' `readdir` and `stat` — both read-only. It never
 *   calls `writeFile`/`rename`/`unlink`/`rmdir`/`chmod`/`copyFile`, and
 *   never moves, renames, or deletes anything in the inspected folder.
 * - **Proposed `storageKey` convention:** the value a real 11D-1 import
 *   WOULD persist as `Video.storageKey`, computed as each file's path
 *   relative to the passed `folderPath` — mirroring
 *   `ImportManifestItem.storageKey`'s "path relative to STORAGE_ROOT"
 *   convention, except this dry-run has no knowledge of `STORAGE_ROOT` (by
 *   design — see above) and so reports paths relative to whatever folder
 *   root the caller explicitly passed in. A real import run would need to
 *   combine this with wherever the folder actually sits under
 *   `STORAGE_ROOT`; that mapping is deliberately out of scope here.
 * - **Deterministic ordering:** discovered files are natural-sorted (`1`,
 *   `2`, `10`, not the lexical `1`, `10`, `2`) before
 *   `proposedEpisodeNumber`/`proposedSortOrder` are assigned, mirroring
 *   `MediaImporterService`'s `items[index] -> sortOrder: index` convention.
 * - **Retry/failure reporting mirrors `MediaImporterService.importItem`**:
 *   each file gets up to `maxAttempts` ffprobe attempts (default 3) before
 *   being reported as `probe_failed` — a failure never aborts the rest of
 *   the folder, and since this service performs no writes at all, there is
 *   never a partial write to worry about either way.
 */
@Injectable()
export class MediaDryRunService {
  private readonly logger = new Logger(MediaDryRunService.name);

  constructor(
    @Inject(FFPROBE_CLIENT) private readonly ffprobeClient: FfprobeClient,
  ) {}

  async inspect(
    folderPath: string,
    options?: DryRunOptions,
  ): Promise<DryRunReport> {
    this.assertFolderPathProvided(folderPath);
    await this.assertFolderExists(folderPath);

    const maxAttempts = options?.maxAttempts ?? DEFAULT_DRYRUN_MAX_ATTEMPTS;
    const fileNames = await this.discoverVideoFileNames(folderPath);
    const orderedFileNames = this.sortFileNamesNaturally(fileNames);

    const items: DryRunItemResult[] = [];
    for (const [index, fileName] of orderedFileNames.entries()) {
      items.push(
        await this.inspectFile(folderPath, fileName, index, maxAttempts),
      );
    }

    return {
      folderPath,
      items,
      discoveredCount: items.length,
      succeeded: items.filter((item) => item.status === 'ok').length,
      failed: items.filter((item) => item.status === 'probe_failed').length,
    };
  }

  private assertFolderPathProvided(folderPath: string): void {
    if (!folderPath || folderPath.trim().length === 0) {
      throw new AppException(
        AppErrorCode.DRY_RUN_FOLDER_PATH_REQUIRED,
        'A folder path is required — the dry-run importer never defaults to STORAGE_ROOT or any other directory',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async assertFolderExists(folderPath: string): Promise<void> {
    let stats: Stats;
    try {
      stats = await stat(folderPath);
    } catch {
      throw new AppException(
        AppErrorCode.DRY_RUN_FOLDER_NOT_FOUND,
        `Dry-run folder not found: "${folderPath}"`,
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!stats.isDirectory()) {
      throw new AppException(
        AppErrorCode.DRY_RUN_FOLDER_NOT_FOUND,
        `Dry-run path is not a directory: "${folderPath}"`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /** Top-level, read-only listing — never recurses, never follows into subdirectories. */
  private async discoverVideoFileNames(folderPath: string): Promise<string[]> {
    const entries: Dirent[] = await readdir(folderPath, {
      withFileTypes: true,
    });

    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) =>
        SUPPORTED_DRYRUN_VIDEO_EXTENSIONS.includes(extname(name).toLowerCase()),
      );
  }

  private async inspectFile(
    folderPath: string,
    fileName: string,
    sortOrder: number,
    maxAttempts: number,
  ): Promise<DryRunItemResult> {
    const absolutePath = join(folderPath, fileName);
    const proposedStorageKey = relative(folderPath, absolutePath);
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const metadata = await this.ffprobeClient.probe(absolutePath);
        return {
          fileName,
          proposedEpisodeNumber: sortOrder + 1,
          proposedSortOrder: sortOrder,
          proposedStorageKey,
          status: 'ok',
          metadata,
        };
      } catch (error) {
        lastError = error;
        this.logger.warn(
          `ffprobe attempt ${attempt}/${maxAttempts} failed while dry-run-inspecting "${fileName}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return {
      fileName,
      proposedEpisodeNumber: sortOrder + 1,
      proposedSortOrder: sortOrder,
      proposedStorageKey,
      status: 'probe_failed',
      attempts: maxAttempts,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    };
  }

  /**
   * Natural sort: `1.mp4`, `2.mp4`, `10.mp4` compares numeric runs by
   * value (not lexically, which would give `1`, `10`, `2`), and non-numeric
   * runs lexically. Deterministic and total, so `Array.prototype.sort`
   * never leaves ties undefined for two distinct filenames.
   */
  private sortFileNamesNaturally(fileNames: string[]): string[] {
    return [...fileNames].sort((a, b) => this.naturalCompare(a, b));
  }

  private naturalCompare(a: string, b: string): number {
    const chunkPattern = /(\d+|\D+)/g;
    const aChunks = a.match(chunkPattern) ?? [a];
    const bChunks = b.match(chunkPattern) ?? [b];
    const length = Math.max(aChunks.length, bChunks.length);

    for (let index = 0; index < length; index += 1) {
      const comparison = this.compareChunk(
        aChunks[index] ?? '',
        bChunks[index] ?? '',
      );
      if (comparison !== 0) {
        return comparison;
      }
    }

    return 0;
  }

  private compareChunk(aChunk: string, bChunk: string): number {
    const numericPattern = /^\d+$/;
    const bothNumeric =
      numericPattern.test(aChunk) && numericPattern.test(bChunk);

    if (bothNumeric) {
      return Number(aChunk) - Number(bChunk);
    }

    if (aChunk === bChunk) {
      return 0;
    }
    return aChunk < bChunk ? -1 : 1;
  }
}
