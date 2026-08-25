import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { R2_MIGRATION_APPLY_BUCKET_ENV } from './r2-media-migration-env-guard';
import { R2MediaMigrationService } from './r2-media-migration.service';

/**
 * Work unit "R2 MEDIA MIGRATION": the safety properties, proven against
 * mocks. NO NETWORK CALL AND NO REAL DATABASE — `StorageService` and
 * `PrismaService` are plain jest doubles, and the "local media" is a real
 * temp directory this file creates and removes.
 *
 * `STORAGE_ROOT` is a genuine temp dir rather than a mock because
 * `resolveSafeStoragePath` + `fs.stat` are exactly the pair whose behavior
 * (missing file, directory-instead-of-file, traversal refusal) these tests
 * exist to pin down.
 */
describe('R2MediaMigrationService', () => {
  let storageRoot: string;
  let bucket: string;

  const originalApplyBucket = process.env[R2_MIGRATION_APPLY_BUCKET_ENV];

  beforeEach(() => {
    storageRoot = mkdtempSync(join(tmpdir(), 'r2-migration-spec-'));
    bucket = 'spec-bucket';
    delete process.env[R2_MIGRATION_APPLY_BUCKET_ENV];
  });

  afterEach(() => {
    rmSync(storageRoot, { recursive: true, force: true });
    if (originalApplyBucket === undefined) {
      delete process.env[R2_MIGRATION_APPLY_BUCKET_ENV];
    } else {
      process.env[R2_MIGRATION_APPLY_BUCKET_ENV] = originalApplyBucket;
    }
  });

  function writeSource(relativePath: string, bytes: number): void {
    const full = join(storageRoot, relativePath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, Buffer.alloc(bytes, 1));
  }

  interface Row {
    id: string;
    seriesId: string;
    episodeNumber: number;
    storageKey: string;
  }

  function build(
    rows: Row[],
    overrides: {
      headObject?: jest.Mock;
      putObject?: jest.Mock;
      updateMany?: jest.Mock;
      driver?: string;
    } = {},
  ): {
    service: R2MediaMigrationService;
    putObject: jest.Mock;
    updateMany: jest.Mock;
    headObject: jest.Mock;
  } {
    const headObject =
      overrides.headObject ?? jest.fn().mockResolvedValue(null);
    const putObject =
      overrides.putObject ?? jest.fn().mockResolvedValue(undefined);
    const updateMany =
      overrides.updateMany ?? jest.fn().mockResolvedValue({ count: 1 });

    const prisma = {
      video: {
        count: jest.fn().mockResolvedValue(rows.length),
        findMany: jest.fn().mockResolvedValue(rows),
        updateMany,
      },
    } as unknown as PrismaService;

    const storage = { headObject, putObject } as unknown as StorageService;

    const configService = {
      get: (key: string) =>
        key === 'app'
          ? { storageRoot }
          : { bucket, driver: overrides.driver ?? 'r2' },
    } as unknown as ConfigService;

    return {
      service: new R2MediaMigrationService(prisma, storage, configService),
      putObject,
      updateMany,
      headObject,
    };
  }

  const ROW: Row = {
    id: 'video-104-01',
    seriesId: 'series-104',
    episodeNumber: 1,
    storageKey: 'Series 104/1_subtitled.mp4',
  };

  describe('inventory (the default mode)', () => {
    it('writes nothing to the bucket or the database', async () => {
      writeSource(ROW.storageKey, 128);
      const { service, putObject, updateMany } = build([ROW]);

      const report = await service.run({ mode: 'inventory' });

      expect(report.dryRun).toBe(true);
      expect(putObject).not.toHaveBeenCalled();
      expect(updateMany).not.toHaveBeenCalled();
    });

    it('maps each row to admin-media/<id>/source and records the local size', async () => {
      writeSource(ROW.storageKey, 128);
      const { service } = build([ROW]);

      const report = await service.run({ mode: 'inventory' });

      expect(report.candidates[0]).toMatchObject({
        videoId: 'video-104-01',
        objectKey: 'admin-media/video-104-01/source',
        sourceBytes: 128,
        blockedReason: null,
      });
      expect(report.ready).toBe(1);
    });

    it('does not contact the bucket at all unless --check-remote is passed', async () => {
      writeSource(ROW.storageKey, 128);
      const { service, headObject } = build([ROW]);

      await service.run({ mode: 'inventory' });

      expect(headObject).not.toHaveBeenCalled();
    });

    it('reports a missing source file instead of throwing, so one bad row cannot abort the batch', async () => {
      const good = { ...ROW };
      const bad = {
        ...ROW,
        id: 'video-104-02',
        storageKey: 'Series 104/2_subtitled.mp4',
      };
      writeSource(good.storageKey, 64);
      const { service } = build([good, bad]);

      const report = await service.run({ mode: 'inventory' });

      expect(report.ready).toBe(1);
      expect(report.blocked).toBe(1);
      expect(
        report.candidates.find((c) => c.videoId === 'video-104-02')
          ?.blockedReason,
      ).toBe('source_file_missing');
    });

    it('refuses a storageKey that escapes STORAGE_ROOT', async () => {
      const evil = { ...ROW, storageKey: '../../etc/passwd' };
      const { service } = build([evil]);

      const report = await service.run({ mode: 'inventory' });

      expect(report.candidates[0].blockedReason).toBe('source_path_unsafe');
    });

    it('refuses a source that is a directory rather than a file', async () => {
      mkdirSync(join(storageRoot, 'Series 104/1_subtitled.mp4'), {
        recursive: true,
      });
      const { service } = build([ROW]);

      const report = await service.run({ mode: 'inventory' });

      expect(report.candidates[0].blockedReason).toBe('source_not_a_file');
    });
  });

  describe('writing modes are gated', () => {
    it('refuses --upload when the operator has not restated the bucket', async () => {
      writeSource(ROW.storageKey, 64);
      const { service, putObject } = build([ROW]);

      await expect(service.run({ mode: 'upload' })).rejects.toThrow(
        new RegExp(`${R2_MIGRATION_APPLY_BUCKET_ENV} is not set`),
      );
      expect(putObject).not.toHaveBeenCalled();
    });

    it('refuses --link when the restated bucket is a DIFFERENT bucket', async () => {
      process.env[R2_MIGRATION_APPLY_BUCKET_ENV] = 'some-other-bucket';
      writeSource(ROW.storageKey, 64);
      const { service, updateMany } = build([ROW]);

      await expect(service.run({ mode: 'link' })).rejects.toThrow(
        /does not match OBJECT_STORAGE_BUCKET/,
      );
      expect(updateMany).not.toHaveBeenCalled();
    });
  });

  describe('upload', () => {
    beforeEach(() => {
      process.env[R2_MIGRATION_APPLY_BUCKET_ENV] = 'spec-bucket';
    });

    it('uploads a ready row with the video/mp4 content type', async () => {
      writeSource(ROW.storageKey, 64);
      const { service, putObject } = build([ROW]);

      const report = await service.run({ mode: 'upload' });

      expect(putObject).toHaveBeenCalledWith(
        'admin-media/video-104-01/source',
        expect.any(Buffer),
        'video/mp4',
      );
      expect(report.uploaded).toBe(1);
    });

    it('is restartable — skips a destination already present at the right size', async () => {
      writeSource(ROW.storageKey, 64);
      const { service, putObject } = build([ROW], {
        headObject: jest.fn().mockResolvedValue({
          key: 'admin-media/video-104-01/source',
          contentLength: 64,
        }),
      });

      const report = await service.run({ mode: 'upload' });

      expect(putObject).not.toHaveBeenCalled();
      expect(report.skippedAlreadyUploaded).toBe(1);
      expect(report.uploaded).toBe(0);
    });

    it('re-uploads a destination present at the WRONG size (a truncated previous attempt)', async () => {
      writeSource(ROW.storageKey, 64);
      const { service, putObject } = build([ROW], {
        headObject: jest.fn().mockResolvedValue({
          key: 'admin-media/video-104-01/source',
          contentLength: 12,
        }),
      });

      const report = await service.run({ mode: 'upload' });

      expect(putObject).toHaveBeenCalledTimes(1);
      expect(report.uploaded).toBe(1);
    });

    it('never writes to the database', async () => {
      writeSource(ROW.storageKey, 64);
      const { service, updateMany } = build([ROW]);

      await service.run({ mode: 'upload' });

      expect(updateMany).not.toHaveBeenCalled();
    });
  });

  describe('link', () => {
    beforeEach(() => {
      process.env[R2_MIGRATION_APPLY_BUCKET_ENV] = 'spec-bucket';
    });

    it('re-confirms the object by HEAD in the same run before writing', async () => {
      writeSource(ROW.storageKey, 64);
      const headObject = jest.fn().mockResolvedValue({
        key: 'admin-media/video-104-01/source',
        contentLength: 64,
      });
      const { service } = build([ROW], { headObject });

      const report = await service.run({ mode: 'link' });

      expect(headObject).toHaveBeenCalledWith(
        'admin-media/video-104-01/source',
      );
      expect(report.linked).toBe(1);
    });

    it('writes as a compare-and-set that cannot overwrite an existing objectStorageKey', async () => {
      writeSource(ROW.storageKey, 64);
      const { service, updateMany } = build([ROW], {
        headObject: jest
          .fn()
          .mockResolvedValue({ key: 'k', contentLength: 64 }),
      });

      await service.run({ mode: 'link' });

      expect(updateMany).toHaveBeenCalledWith({
        where: { id: 'video-104-01', objectStorageKey: null },
        data: { objectStorageKey: 'admin-media/video-104-01/source' },
      });
    });

    it('REFUSES to link a row whose object is absent', async () => {
      writeSource(ROW.storageKey, 64);
      const { service, updateMany } = build([ROW], {
        headObject: jest.fn().mockResolvedValue(null),
      });

      const report = await service.run({ mode: 'link' });

      expect(updateMany).not.toHaveBeenCalled();
      expect(report.linked).toBe(0);
      expect(report.verifiedMismatch).toBe(1);
    });

    it('REFUSES to link a row whose object is the wrong size (truncated upload)', async () => {
      writeSource(ROW.storageKey, 64);
      const { service, updateMany } = build([ROW], {
        headObject: jest.fn().mockResolvedValue({ key: 'k', contentLength: 9 }),
      });

      const report = await service.run({ mode: 'link' });

      expect(updateMany).not.toHaveBeenCalled();
      expect(report.verifiedMismatch).toBe(1);
    });

    it('reports, rather than clobbers, a row linked by someone else mid-run', async () => {
      writeSource(ROW.storageKey, 64);
      const { service } = build([ROW], {
        headObject: jest
          .fn()
          .mockResolvedValue({ key: 'k', contentLength: 64 }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      });

      const report = await service.run({ mode: 'link' });

      expect(report.linked).toBe(0);
      expect(report.warnings.join(' ')).toMatch(/linked by someone else/);
    });

    it('never links a blocked row', async () => {
      // No source file written -> blocked -> must not reach the database.
      const { service, updateMany } = build([ROW], {
        headObject: jest
          .fn()
          .mockResolvedValue({ key: 'k', contentLength: 64 }),
      });

      const report = await service.run({ mode: 'link' });

      expect(report.blocked).toBe(1);
      expect(updateMany).not.toHaveBeenCalled();
    });
  });

  describe('verify', () => {
    it('is read-only and scores a size mismatch as a failure, not a success', async () => {
      writeSource(ROW.storageKey, 64);
      const { service, putObject, updateMany } = build([ROW], {
        headObject: jest
          .fn()
          .mockResolvedValue({ key: 'k', contentLength: 63 }),
      });

      const report = await service.run({ mode: 'verify' });

      expect(report.dryRun).toBe(true);
      expect(putObject).not.toHaveBeenCalled();
      expect(updateMany).not.toHaveBeenCalled();
      expect(report.verifiedOk).toBe(0);
      expect(report.verifiedMismatch).toBe(1);
    });
  });

  it('selects only rows with no objectStorageKey and a non-empty storageKey (excluding the QA fixtures)', async () => {
    writeSource(ROW.storageKey, 64);
    const rows = [ROW];
    const prismaFindMany = jest.fn().mockResolvedValue(rows);
    const prisma = {
      video: {
        count: jest.fn().mockResolvedValue(42),
        findMany: prismaFindMany,
        updateMany: jest.fn(),
      },
    } as unknown as PrismaService;
    const storage = {
      headObject: jest.fn().mockResolvedValue(null),
      putObject: jest.fn(),
    } as unknown as StorageService;
    const configService = {
      get: (key: string) =>
        key === 'app' ? { storageRoot } : { bucket, driver: 'r2' },
    } as unknown as ConfigService;

    await new R2MediaMigrationService(prisma, storage, configService).run({
      mode: 'inventory',
    });

    expect(prismaFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { objectStorageKey: null, NOT: { storageKey: '' } },
      }),
    );
  });
});
