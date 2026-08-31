import { copyFile, mkdir, open, readdir } from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import { dirname, extname, join, resolve } from 'path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RootConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import {
  COVER_MAGIC_BYTE_LENGTH,
  resolveLocalCoverPath,
  sniffSeriesCoverContentType,
} from '../local-series-cover.util';
import { buildSeriesCoverObjectKey } from '../series-cover-key.util';
import { MAX_SERIES_COVER_UPLOAD_BYTES } from '../series-cover.constants';
import {
  LocalCoverIngestOutcome,
  LocalCoverIngestReport,
  LocalCoverIngestRunOptions,
} from './local-cover-ingest.types';

/**
 * Work unit "LOCAL SERIES COVER ARTWORK": ingests real, project-owned poster
 * files into the `local` driver's object store and points each `Series` row
 * at the result — the local-driver counterpart of the admin
 * presign/PUT/complete flow (`SeriesService.createCoverUpload` +
 * `completeCoverUpload`), which cannot be used here because it presigns
 * against a bucket the `local` driver does not have.
 *
 * IT MIRRORS THAT FLOW RATHER THAN INVENTING A SHORTCUT, in every way that
 * matters to what ends up in the database:
 *
 *  - the key comes from `buildSeriesCoverObjectKey` — the SAME versioned
 *    `admin-series/<id>/cover/<uuid>` layout R2 gets, so a row ingested
 *    locally is byte-for-byte migratable to R2 later and needs no re-keying;
 *  - the bytes are verified BEFORE the row is updated (format sniffed from
 *    the file's own leading bytes, size bounded by the same
 *    `MAX_SERIES_COVER_UPLOAD_BYTES` the upload contract enforces), so
 *    `coverImageKey` is never pointed at something unservable;
 *  - the write goes through Prisma, not raw SQL, and touches exactly one
 *    column on exactly the matched rows. No `Video` row, no episode access
 *    tier, and no other `Series` column is read for update or written.
 *
 * IT IS NOT A SEEDER. It never creates a `Series`, and a series with no
 * matching asset file is reported as `skipped`, not invented.
 */
@Injectable()
export class LocalCoverIngestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<RootConfig>,
  ) {}

  /**
   * Ingests every asset in `sourceDir` whose filename stem names an existing,
   * non-archived `Series`.
   *
   * Refuses outright — before touching any file or row — unless
   * `STORAGE_DRIVER` is `local`. Under `r2` the authoritative artwork lives
   * in the bucket and `coverUrl` is a presigned URL to it; writing local keys
   * over those rows would silently repoint production covers at files that
   * only exist on one machine. The same fail-closed, restate-the-target shape
   * `series-cover-orphan-env-guard.ts` uses for its own destructive path.
   *
   * A dry run (`apply: false`, the default) reports exactly what an apply
   * would do and writes nothing — no file copied, no row updated.
   */
  async run(
    options: LocalCoverIngestRunOptions,
  ): Promise<LocalCoverIngestReport> {
    const storageConfig = this.configService.get('storage', { infer: true })!;

    if (storageConfig.driver !== 'local') {
      throw new Error(
        `Refusing to ingest: STORAGE_DRIVER is ${JSON.stringify(
          storageConfig.driver,
        )}, not "local". Under the r2 driver a series cover is uploaded ` +
          'through POST /admin/series/:id/cover and stored in the bucket; ' +
          'writing local object keys over those rows would repoint live ' +
          'covers at files that exist on one machine only.',
      );
    }

    const sourceDir = resolve(options.sourceDir);
    const localRoot = storageConfig.localRoot;
    const assets = await this.readAssetsByStem(sourceDir);

    const series = await this.prisma.series.findMany({
      where: { archivedAt: null },
      select: { id: true, title: true, coverImageKey: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });

    const outcomes: LocalCoverIngestOutcome[] = [];

    for (const row of series) {
      outcomes.push(
        await this.ingestOne(row, assets, {
          localRoot,
          apply: options.apply,
        }),
      );
    }

    return {
      driver: storageConfig.driver,
      sourceDir,
      localRoot,
      applied: options.apply,
      outcomes,
    };
  }

  /**
   * One series. Every failure is REPORTED, never thrown — a single unreadable
   * asset must not abandon the other three mid-run, which would leave the
   * catalog half-covered and the operator guessing which half.
   */
  private async ingestOne(
    row: { id: string; title: string; coverImageKey: string | null },
    assets: Map<string, string>,
    context: { localRoot: string; apply: boolean },
  ): Promise<LocalCoverIngestOutcome> {
    const base = { seriesId: row.id, title: row.title };
    const sourcePath = assets.get(row.id);

    if (sourcePath === undefined) {
      return {
        ...base,
        status: 'skipped',
        reason: 'No asset file whose name stem matches this series id',
      };
    }

    const verified = await verifyCoverAsset(sourcePath);

    if ('reason' in verified) {
      return { ...base, status: 'failed', sourcePath, reason: verified.reason };
    }

    const key = buildSeriesCoverObjectKey(row.id);
    const destinationPath = resolveLocalCoverPath(context.localRoot, key);

    if (destinationPath === null) {
      // Unreachable for a key this process just built from the two fixed
      // literals plus a UUID — asserted rather than assumed, because the
      // alternative to reporting it is copying a file outside the root.
      return {
        ...base,
        status: 'failed',
        sourcePath,
        reason: `Refusing to write: key "${key}" resolves outside the local object root`,
      };
    }

    if (!context.apply) {
      return {
        ...base,
        status: 'would-ingest',
        sourcePath,
        key,
        contentType: verified.contentType,
        bytes: verified.bytes,
        previousCoverImageKey: row.coverImageKey,
      };
    }

    await mkdir(dirname(destinationPath), { recursive: true });
    // Copy the OBJECT INTO PLACE FIRST, then repoint the row. The reverse
    // order would leave `coverImageKey` naming a file that does not exist yet
    // — a window in which `GET /series` advertises a cover URL that 404s.
    // This order's worst case is an orphaned object with no row pointing at
    // it, which is exactly what the existing cover-orphan sweep is for.
    await copyFile(sourcePath, destinationPath);

    await this.prisma.series.update({
      where: { id: row.id },
      data: { coverImageKey: key },
    });

    return {
      ...base,
      status: 'ingested',
      sourcePath,
      key,
      contentType: verified.contentType,
      bytes: verified.bytes,
      previousCoverImageKey: row.coverImageKey,
    };
  }

  /**
   * Maps each asset file's NAME STEM to its absolute path — `series-104.webp`
   * becomes `series-104`. The stem is the join key to `Series.id`, matching
   * the convention the public website's `public/posters/` directory already
   * documents and uses for the same four covers, so one artwork set works in
   * both places with no per-repo mapping table to drift.
   *
   * Only regular files directly in `sourceDir` are considered; no recursion,
   * so a stray nested directory cannot contribute a surprise match.
   */
  private async readAssetsByStem(
    sourceDir: string,
  ): Promise<Map<string, string>> {
    const entries = await readdir(sourceDir, { withFileTypes: true });
    const assets = new Map<string, string>();

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const extension = extname(entry.name);

      if (extension.length === 0) {
        continue;
      }

      assets.set(
        entry.name.slice(0, -extension.length),
        join(sourceDir, entry.name),
      );
    }

    return assets;
  }
}

/**
 * Confirms a candidate asset is a real, in-bounds cover image before anything
 * is copied or any row is repointed — the local equivalent of
 * `completeCoverUpload`'s `headObject` verification, and held to the same two
 * bounds: the closed format allow-list and `MAX_SERIES_COVER_UPLOAD_BYTES`.
 *
 * Returns a reason string rather than throwing, so the caller can report a bad
 * asset alongside the good ones.
 */
async function verifyCoverAsset(
  sourcePath: string,
): Promise<{ contentType: string; bytes: number } | { reason: string }> {
  let handle: FileHandle | undefined;

  try {
    handle = await open(sourcePath, 'r');

    const stats = await handle.stat();

    if (!stats.isFile()) {
      return { reason: 'Not a regular file' };
    }

    if (stats.size === 0) {
      return { reason: 'File is empty' };
    }

    if (stats.size > MAX_SERIES_COVER_UPLOAD_BYTES) {
      return {
        reason: `File is ${stats.size} bytes, over the ${MAX_SERIES_COVER_UPLOAD_BYTES}-byte cover ceiling`,
      };
    }

    const header = Buffer.alloc(COVER_MAGIC_BYTE_LENGTH);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const contentType = sniffSeriesCoverContentType(
      header.subarray(0, bytesRead),
    );

    if (contentType === null) {
      return {
        reason:
          'Leading bytes are not a permitted cover format (JPEG, PNG or WebP)',
      };
    }

    return { contentType, bytes: stats.size };
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await handle?.close();
  }
}
