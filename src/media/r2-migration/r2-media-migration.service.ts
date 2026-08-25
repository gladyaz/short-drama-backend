import { readFile, stat } from 'fs/promises';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RootConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { resolveSafeStoragePath } from '../../videos/storage-path.util';
import {
  MIGRATION_CONTENT_TYPE,
  MIGRATION_DEFAULT_LIMIT,
  MIGRATION_MAX_SOURCE_BYTES,
  buildMigrationObjectKey,
} from './r2-media-migration.constants';
import {
  assertMigrationApplyAllowed,
  R2_MIGRATION_APPLY_BUCKET_ENV,
} from './r2-media-migration-env-guard';
import type {
  MigrationCandidate,
  MigrationReport,
} from './r2-media-migration.types';

export interface MigrationRunOptions {
  mode: 'inventory' | 'upload' | 'verify' | 'link';
  /** Inventory only: whether to HEAD each destination key. Costs one call per row. */
  checkRemote?: boolean;
  limit?: number;
}

/**
 * Work unit "R2 MEDIA MIGRATION": moves the local-filesystem catalog into
 * object storage, in four separately-invoked steps.
 *
 * WHY FOUR STEPS AND NOT ONE. Uploading bytes and repointing the database
 * are different kinds of risk. An interrupted upload costs bandwidth; a
 * database write applied against an object that is not actually there costs
 * a broken catalog that looks migrated. Splitting them means the DB is only
 * ever repointed at objects a separate step has already HEAD-confirmed, and
 * a failed run at any stage is recovered by re-running the same command.
 *
 * SAFETY PROPERTIES, each enforced by construction rather than by caller
 * discipline:
 *
 *  - READ-ONLY BY DEFAULT. `inventory` is the default mode and touches
 *    neither bucket nor database. `upload`/`link` additionally require the
 *    bucket-restatement gate in `r2-media-migration-env-guard.ts`.
 *  - NEVER OVERWRITES A LINK. Eligibility is `objectStorageKey IS NULL`,
 *    and the `link` write is a compare-and-set `updateMany` carrying that
 *    same predicate — so a row that gained a key between selection and write
 *    is skipped rather than clobbered, with no transaction required.
 *  - NEVER TOUCHES THE QA FIXTURES. Both already carry an
 *    `objectStorageKey`, so the same predicate excludes them.
 *  - NEVER DELETES OR MODIFIES LOCAL FILES. This service opens sources
 *    read-only; there is no unlink, rename, or write path to `STORAGE_ROOT`
 *    anywhere in it.
 *  - NEVER GUESSES A FILENAME. Every source path comes from that row's own
 *    `storageKey`, resolved through the SAME `resolveSafeStoragePath` the
 *    streaming endpoint uses — so a key escaping `STORAGE_ROOT` is refused
 *    here exactly as it is at request time. The source directories hold 277
 *    MP4s against 40 catalogued rows, so directory globbing would migrate
 *    files no row references.
 *  - IDEMPOTENT AND RESTARTABLE. `upload` skips a destination that already
 *    exists with a matching byte length; `link` skips a row already linked.
 *    Re-running any mode after any failure converges.
 */
@Injectable()
export class R2MediaMigrationService {
  private readonly logger = new Logger(R2MediaMigrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly configService: ConfigService<RootConfig>,
  ) {}

  async run(options: MigrationRunOptions): Promise<MigrationReport> {
    const appConfig = this.configService.get('app', { infer: true })!;
    const storageConfig = this.configService.get('storage', { infer: true })!;
    const isWritingMode = options.mode === 'upload' || options.mode === 'link';

    if (isWritingMode) {
      assertMigrationApplyAllowed({
        configuredBucket: storageConfig.bucket,
        restatedBucket: process.env[R2_MIGRATION_APPLY_BUCKET_ENV],
        storageDriver: storageConfig.driver,
      });
    }

    const limit = options.limit ?? MIGRATION_DEFAULT_LIMIT;
    const warnings: string[] = [];

    const totalRowsConsidered = await this.prisma.video.count();
    const alreadyLinked = await this.prisma.video.count({
      where: { NOT: { objectStorageKey: null } },
    });

    const rows = await this.prisma.video.findMany({
      where: { objectStorageKey: null, NOT: { storageKey: '' } },
      select: {
        id: true,
        seriesId: true,
        episodeNumber: true,
        storageKey: true,
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      take: limit,
    });

    if (rows.length === limit) {
      warnings.push(
        `Hit the row limit (${limit}). More eligible rows may exist — re-run after this batch, or raise --limit.`,
      );
    }

    const candidates: MigrationCandidate[] = [];
    const seenObjectKeys = new Map<string, string>();

    for (const row of rows) {
      const candidate = await this.resolveCandidate(
        row,
        appConfig.storageRoot,
        seenObjectKeys,
      );
      candidates.push(candidate);
    }

    const report: MigrationReport = {
      mode: options.mode,
      dryRun: !isWritingMode,
      bucket: storageConfig.bucket || null,
      storageRoot: appConfig.storageRoot,
      totalRowsConsidered,
      eligible: candidates.length,
      alreadyLinked,
      ready: candidates.filter((c) => c.blockedReason === null).length,
      blocked: candidates.filter((c) => c.blockedReason !== null).length,
      uploaded: 0,
      skippedAlreadyUploaded: 0,
      verifiedOk: 0,
      verifiedMismatch: 0,
      linked: 0,
      candidates,
      warnings,
    };

    if (options.mode === 'inventory') {
      if (options.checkRemote) {
        await this.annotateRemoteState(report);
      }
      return report;
    }

    if (options.mode === 'upload') {
      await this.performUploads(report);
      return report;
    }

    if (options.mode === 'verify') {
      await this.annotateRemoteState(report);
      this.scoreVerification(report);
      return report;
    }

    await this.performLink(report);
    return report;
  }

  /**
   * Resolves one row against local disk. Never throws for a row-level
   * problem — a missing or oversized source becomes a REPORTED
   * `blockedReason`, so one bad row cannot abort an otherwise-good batch.
   * `resolveSafeStoragePath` throwing (a key escaping `STORAGE_ROOT`) is
   * caught for the same reason and surfaces as `source_path_unsafe`.
   */
  private async resolveCandidate(
    row: {
      id: string;
      seriesId: string;
      episodeNumber: number;
      storageKey: string;
    },
    storageRoot: string,
    seenObjectKeys: Map<string, string>,
  ): Promise<MigrationCandidate> {
    const objectKey = buildMigrationObjectKey(row.id);

    const base: MigrationCandidate = {
      videoId: row.id,
      seriesId: row.seriesId,
      episodeNumber: row.episodeNumber,
      storageKey: row.storageKey,
      sourcePath: '',
      objectKey,
      sourceBytes: null,
      blockedReason: null,
      remoteExists: null,
      remoteBytes: null,
    };

    // Structurally impossible for a primary-key-derived scheme, checked
    // anyway: if it ever fires, the key rule has been changed to something
    // non-injective and two rows are about to overwrite each other's media.
    const previousOwner = seenObjectKeys.get(objectKey);
    if (previousOwner !== undefined) {
      return { ...base, blockedReason: 'duplicate_destination_key' };
    }
    seenObjectKeys.set(objectKey, row.id);

    let sourcePath: string;
    try {
      sourcePath = resolveSafeStoragePath(storageRoot, row.storageKey);
    } catch {
      return { ...base, blockedReason: 'source_path_unsafe' };
    }

    try {
      const stats = await stat(sourcePath);
      if (!stats.isFile()) {
        return { ...base, sourcePath, blockedReason: 'source_not_a_file' };
      }
      if (stats.size > MIGRATION_MAX_SOURCE_BYTES) {
        return {
          ...base,
          sourcePath,
          sourceBytes: stats.size,
          blockedReason: 'source_too_large',
        };
      }
      return { ...base, sourcePath, sourceBytes: stats.size };
    } catch {
      return { ...base, sourcePath, blockedReason: 'source_file_missing' };
    }
  }

  /** HEADs every candidate's destination key. Read-only against the bucket. */
  private async annotateRemoteState(report: MigrationReport): Promise<void> {
    for (const candidate of report.candidates) {
      const head = await this.storage.headObject(candidate.objectKey);
      candidate.remoteExists = head !== null;
      candidate.remoteBytes = head?.contentLength ?? null;
    }
  }

  /**
   * `verify` scores what `annotateRemoteState` found. A present object whose
   * byte length differs from the local source is a MISMATCH, not a success:
   * that is what a truncated or interrupted upload looks like, and it is
   * precisely the state that must never be linked into the catalog.
   */
  private scoreVerification(report: MigrationReport): void {
    for (const candidate of report.candidates) {
      if (candidate.blockedReason !== null || !candidate.remoteExists) {
        continue;
      }
      if (
        candidate.sourceBytes !== null &&
        candidate.remoteBytes === candidate.sourceBytes
      ) {
        report.verifiedOk += 1;
      } else {
        report.verifiedMismatch += 1;
      }
    }
  }

  /**
   * Uploads each ready candidate, skipping any destination already present
   * at the correct byte length — which is what makes an interrupted run
   * cheap to resume. A present object of the WRONG length is re-uploaded:
   * it is a failed previous attempt, and `PutObject` overwrites the whole
   * object atomically, so re-sending is the repair.
   */
  private async performUploads(report: MigrationReport): Promise<void> {
    for (const candidate of report.candidates) {
      if (candidate.blockedReason !== null) {
        continue;
      }

      const head = await this.storage.headObject(candidate.objectKey);
      candidate.remoteExists = head !== null;
      candidate.remoteBytes = head?.contentLength ?? null;

      if (head !== null && head.contentLength === candidate.sourceBytes) {
        report.skippedAlreadyUploaded += 1;
        continue;
      }

      const body = await readFile(candidate.sourcePath);
      await this.storage.putObject(
        candidate.objectKey,
        body,
        MIGRATION_CONTENT_TYPE,
      );

      candidate.remoteExists = true;
      candidate.remoteBytes = body.byteLength;
      report.uploaded += 1;
      this.logger.log(
        `Uploaded ${candidate.videoId} -> ${candidate.objectKey} (${body.byteLength} bytes)`,
      );
    }
  }

  /**
   * Repoints the database at objects this run has JUST re-confirmed.
   *
   * The HEAD is deliberately re-issued here rather than trusted from an
   * earlier `verify` invocation: `link` is the irreversible-feeling step,
   * and the object's existence must be established by the same process, in
   * the same run, immediately before the write. A missing or wrong-sized
   * object is skipped and counted as a mismatch — never linked.
   *
   * The write is `updateMany` with `objectStorageKey: null` still in the
   * predicate. That makes it a compare-and-set: if anything else linked the
   * row since it was selected, `count` comes back 0 and this run leaves the
   * existing value alone instead of overwriting it.
   */
  private async performLink(report: MigrationReport): Promise<void> {
    for (const candidate of report.candidates) {
      if (candidate.blockedReason !== null) {
        continue;
      }

      const head = await this.storage.headObject(candidate.objectKey);
      candidate.remoteExists = head !== null;
      candidate.remoteBytes = head?.contentLength ?? null;

      if (head === null || head.contentLength !== candidate.sourceBytes) {
        report.verifiedMismatch += 1;
        this.logger.warn(
          `Refusing to link ${candidate.videoId}: object ${candidate.objectKey} is ` +
            `${head === null ? 'absent' : `${head.contentLength} bytes, expected ${String(candidate.sourceBytes)}`}.`,
        );
        continue;
      }

      report.verifiedOk += 1;

      const result = await this.prisma.video.updateMany({
        where: { id: candidate.videoId, objectStorageKey: null },
        data: { objectStorageKey: candidate.objectKey },
      });

      if (result.count === 1) {
        report.linked += 1;
        this.logger.log(
          `Linked ${candidate.videoId} -> ${candidate.objectKey}`,
        );
      } else {
        report.warnings.push(
          `${candidate.videoId} was linked by someone else between selection and write; left untouched.`,
        );
      }
    }
  }
}
