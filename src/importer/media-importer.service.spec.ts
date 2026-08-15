import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { IMPORT_MANIFEST_FIXTURE } from './__fixtures__/import-manifest.fixture';
import { FFPROBE_CLIENT, FfprobeMetadata } from './importer.types';
import { MediaImporterService } from './media-importer.service';

type ProbeMock = jest.Mock<Promise<FfprobeMetadata>, [string]>;

const FIXTURE_METADATA: FfprobeMetadata = {
  durationSeconds: 87,
  width: 720,
  height: 1280,
};

/**
 * Phase 11, work unit 11D-1: `FfprobeClient` is entirely mocked here — no
 * test in this file requires `ffmpeg`/`ffprobe` to be installed or ever
 * runs against a real media file (see `ffprobe-cli.client.ts`'s doc
 * comment: it is not constructed anywhere in this file).
 * `PrismaService` is the real client against the project's Postgres test
 * database, following the existing integration-style precedent; every row
 * this suite creates is namespaced under `importer-fixture-...` and
 * removed in `afterEach`.
 */
describe('MediaImporterService', () => {
  let service: MediaImporterService;
  let prisma: PrismaService;
  let probeMock: ProbeMock;

  beforeEach(async () => {
    probeMock = jest.fn<Promise<FfprobeMetadata>, [string]>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaImporterService,
        PrismaService,
        { provide: FFPROBE_CLIENT, useValue: { probe: probeMock } },
      ],
    }).compile();

    service = module.get<MediaImporterService>(MediaImporterService);
    prisma = module.get<PrismaService>(PrismaService);
    await prisma.onModuleInit();
  });

  afterEach(async () => {
    await prisma.video.deleteMany({
      where: { seriesId: 'importer-fixture-series' },
    });
    await prisma.onModuleDestroy();
  });

  describe('happy path', () => {
    it('imports every fixture item, creating rows with ffprobe-derived metadata and deterministic sortOrder', async () => {
      probeMock.mockResolvedValue(FIXTURE_METADATA);

      const result = await service.importBatch(IMPORT_MANIFEST_FIXTURE);

      expect(result.succeeded).toBe(3);
      expect(result.failed).toBe(0);
      expect(result.results).toEqual([
        {
          id: 'importer-fixture-01',
          status: 'created',
          metadata: FIXTURE_METADATA,
        },
        {
          id: 'importer-fixture-02',
          status: 'created',
          metadata: FIXTURE_METADATA,
        },
        {
          id: 'importer-fixture-03',
          status: 'created',
          metadata: FIXTURE_METADATA,
        },
      ]);

      const rows = await prisma.video.findMany({
        where: { seriesId: 'importer-fixture-series' },
        orderBy: { sortOrder: 'asc' },
      });

      expect(rows.map((row) => row.id)).toEqual([
        'importer-fixture-01',
        'importer-fixture-02',
        'importer-fixture-03',
      ]);
      expect(rows.map((row) => row.sortOrder)).toEqual([0, 1, 2]);
      for (const row of rows) {
        expect(row.durationSeconds).toBe(FIXTURE_METADATA.durationSeconds);
        expect(row.width).toBe(FIXTURE_METADATA.width);
        expect(row.height).toBe(FIXTURE_METADATA.height);
        expect(row.likeCount).toBe(0);
      }
    });

    it('probes each item with its own storageKey', async () => {
      probeMock.mockResolvedValue(FIXTURE_METADATA);

      await service.importBatch(IMPORT_MANIFEST_FIXTURE);

      expect(probeMock).toHaveBeenCalledTimes(3);
      expect(probeMock).toHaveBeenNthCalledWith(
        1,
        'Fixture Series/1_subtitled.mp4',
      );
      expect(probeMock).toHaveBeenNthCalledWith(
        2,
        'Fixture Series/2_subtitled.mp4',
      );
      expect(probeMock).toHaveBeenNthCalledWith(
        3,
        'Fixture Series/3_subtitled.mp4',
      );
    });
  });

  describe('idempotent rerun', () => {
    it('re-running the same manifest updates rows in place instead of duplicating them', async () => {
      probeMock.mockResolvedValue(FIXTURE_METADATA);
      await service.importBatch(IMPORT_MANIFEST_FIXTURE);

      const updatedMetadata: FfprobeMetadata = {
        durationSeconds: 95,
        width: 1080,
        height: 1920,
      };
      probeMock.mockResolvedValue(updatedMetadata);

      const secondRun = await service.importBatch(IMPORT_MANIFEST_FIXTURE);

      expect(secondRun.succeeded).toBe(3);
      expect(secondRun.results.every((r) => r.status === 'updated')).toBe(true);

      const rows = await prisma.video.findMany({
        where: { seriesId: 'importer-fixture-series' },
      });

      // No duplicates: still exactly 3 rows.
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.durationSeconds).toBe(updatedMetadata.durationSeconds);
        expect(row.width).toBe(updatedMetadata.width);
        expect(row.height).toBe(updatedMetadata.height);
      }
    });

    it('does not reset likeCount on a re-import', async () => {
      probeMock.mockResolvedValue(FIXTURE_METADATA);
      await service.importBatch(IMPORT_MANIFEST_FIXTURE);

      await prisma.video.update({
        where: { id: 'importer-fixture-01' },
        data: { likeCount: 42 },
      });

      await service.importBatch(IMPORT_MANIFEST_FIXTURE);

      const row = await prisma.video.findUnique({
        where: { id: 'importer-fixture-01' },
      });
      expect(row?.likeCount).toBe(42);
    });

    it('sortOrder stays deterministic across reruns, including when the manifest order changes', async () => {
      probeMock.mockResolvedValue(FIXTURE_METADATA);
      await service.importBatch(IMPORT_MANIFEST_FIXTURE);

      const reordered = [
        IMPORT_MANIFEST_FIXTURE[2],
        IMPORT_MANIFEST_FIXTURE[0],
        IMPORT_MANIFEST_FIXTURE[1],
      ];
      await service.importBatch(reordered);

      const rows = await prisma.video.findMany({
        where: { seriesId: 'importer-fixture-series' },
        orderBy: { sortOrder: 'asc' },
      });

      expect(rows.map((row) => row.id)).toEqual([
        'importer-fixture-03',
        'importer-fixture-01',
        'importer-fixture-02',
      ]);
    });
  });

  describe('one failed item reported', () => {
    it('reports a single failing item without aborting the rest of the batch, and writes no row for it', async () => {
      probeMock.mockImplementation((sourcePath: string) => {
        if (sourcePath === 'Fixture Series/2_subtitled.mp4') {
          return Promise.reject(new Error('corrupt file'));
        }
        return Promise.resolve(FIXTURE_METADATA);
      });

      const result = await service.importBatch(IMPORT_MANIFEST_FIXTURE, {
        maxAttempts: 2,
      });

      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(1);

      const failure = result.results.find(
        (r) => r.id === 'importer-fixture-02',
      );
      expect(failure).toEqual({
        id: 'importer-fixture-02',
        status: 'failed',
        attempts: 2,
        error: 'corrupt file',
      });

      const failedRow = await prisma.video.findUnique({
        where: { id: 'importer-fixture-02' },
      });
      expect(failedRow).toBeNull();

      const succeededRows = await prisma.video.findMany({
        where: {
          seriesId: 'importer-fixture-series',
          id: { in: ['importer-fixture-01', 'importer-fixture-03'] },
        },
      });
      expect(succeededRows).toHaveLength(2);
    });

    it('retries up to maxAttempts and succeeds if a later attempt works', async () => {
      let callCount = 0;
      probeMock.mockImplementation(() => {
        callCount += 1;
        if (callCount < 3) {
          return Promise.reject(new Error('transient error'));
        }
        return Promise.resolve(FIXTURE_METADATA);
      });

      const result = await service.importBatch([IMPORT_MANIFEST_FIXTURE[0]], {
        maxAttempts: 3,
      });

      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.results[0]).toEqual({
        id: 'importer-fixture-01',
        status: 'created',
        metadata: FIXTURE_METADATA,
      });
      expect(probeMock).toHaveBeenCalledTimes(3);
    });

    it('respects a custom maxAttempts and reports the exact attempt count on failure', async () => {
      probeMock.mockRejectedValue(new Error('always fails'));

      const result = await service.importBatch([IMPORT_MANIFEST_FIXTURE[0]], {
        maxAttempts: 5,
      });

      expect(probeMock).toHaveBeenCalledTimes(5);
      expect(result.results[0]).toMatchObject({
        status: 'failed',
        attempts: 5,
      });
    });

    it('wraps a non-Error rejection into a string error message', async () => {
      probeMock.mockRejectedValue('a plain string rejection');

      const result = await service.importBatch([IMPORT_MANIFEST_FIXTURE[0]], {
        maxAttempts: 1,
      });

      expect(result.results[0]).toMatchObject({
        status: 'failed',
        error: 'a plain string rejection',
      });
    });
  });

  /**
   * Work unit "Episode Access-Tier + Category Contract Hardening": this
   * importer writes `item.category` straight to `Video.category` with no
   * `class-validator` DTO in front of it — closed-set validation is enforced
   * directly in `importItem`, before any ffprobe call or DB write.
   */
  describe('category validation', () => {
    it('rejects an item with an unrecognised category without probing or writing a row, but still processes the rest of the batch', async () => {
      probeMock.mockResolvedValue(FIXTURE_METADATA);

      const invalidItem = {
        ...IMPORT_MANIFEST_FIXTURE[1],
        category: 'thriller',
      };
      const result = await service.importBatch([
        IMPORT_MANIFEST_FIXTURE[0],
        invalidItem,
        IMPORT_MANIFEST_FIXTURE[2],
      ]);

      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(1);

      const failure = result.results.find((r) => r.id === invalidItem.id);
      expect(failure).toMatchObject({
        id: invalidItem.id,
        status: 'failed',
        attempts: 0,
      });
      expect((failure as { error: string }).error).toContain('thriller');

      // Never probed and never written — rejected before either happens.
      expect(probeMock).not.toHaveBeenCalledWith(invalidItem.storageKey);
      const row = await prisma.video.findUnique({
        where: { id: invalidItem.id },
      });
      expect(row).toBeNull();
    });

    it('accepts every canonical category value', async () => {
      probeMock.mockResolvedValue(FIXTURE_METADATA);

      for (const category of ['action', 'comedy', 'drama', 'romance']) {
        const item = {
          ...IMPORT_MANIFEST_FIXTURE[0],
          id: `importer-fixture-category-${category}`,
          category,
        };
        const result = await service.importBatch([item]);
        expect(result.succeeded).toBe(1);
      }

      await prisma.video.deleteMany({
        where: { id: { startsWith: 'importer-fixture-category-' } },
      });
    });
  });
});
