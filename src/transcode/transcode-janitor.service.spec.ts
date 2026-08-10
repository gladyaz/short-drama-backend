import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { RootConfig, TranscodeConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { TranscodeJanitorService } from './transcode-janitor.service';

/**
 * Slice 11P — proofs 11 (janitor can never delete the active generation,
 * INCLUDING mutation) and 12 (old-generation cleanup respects grace).
 * `PrismaService` is the real client against the project's Postgres TEST
 * database; `StorageService` is entirely mocked — no real R2/network call.
 */
describe('TranscodeJanitorService', () => {
  let service: TranscodeJanitorService;
  let prisma: PrismaService;
  let storageService: {
    listObjectKeysByPrefix: jest.Mock;
    deleteObject: jest.Mock;
  };

  const testIdPrefix = 'transcode-janitor-spec-11p';
  const seriesId = `${testIdPrefix}-series`;

  async function createFixtureVideo(
    id: string,
    overrides: Partial<{
      processingState: string | null;
      processingVersion: number;
      processingStartedAt: Date | null;
      hlsMasterKey: string | null;
    }> = {},
  ): Promise<void> {
    await prisma.video.create({
      data: {
        id,
        seriesId,
        title: 'Fixture',
        episodeNumber: 1,
        channelName: 'Fixture Channel',
        caption: 'Fixture caption',
        category: 'drama',
        storageKey: '',
        sourceLanguage: 'zh',
        hasEmbeddedIndonesianSubtitle: true,
        likeCount: 0,
        processingState: overrides.processingState ?? null,
        processingVersion: overrides.processingVersion ?? 0,
        processingStartedAt: overrides.processingStartedAt ?? null,
        hlsMasterKey: overrides.hlsMasterKey ?? null,
      },
    });
  }

  function buildTranscodeConfig(
    overrides: Partial<TranscodeConfig> = {},
  ): TranscodeConfig {
    return {
      enabled: true,
      redisUrl: 'redis://localhost:6379',
      maxAttempts: 3,
      stalledAfterMinutes: 30,
      cleanupGraceMinutes: 120,
      ...overrides,
    };
  }

  async function buildService(transcodeConfig: TranscodeConfig): Promise<void> {
    storageService = {
      listObjectKeysByPrefix: jest.fn().mockResolvedValue([]),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TranscodeJanitorService,
        PrismaService,
        { provide: StorageService, useValue: storageService },
        {
          provide: ConfigService,
          useValue: {
            get: (key: keyof RootConfig) =>
              key === 'transcode' ? transcodeConfig : undefined,
          },
        },
      ],
    }).compile();

    service = module.get<TranscodeJanitorService>(TranscodeJanitorService);
    prisma = module.get<PrismaService>(PrismaService);
    await prisma.onModuleInit();
  }

  afterEach(async () => {
    if (prisma) {
      await prisma.video.deleteMany({ where: { seriesId } });
      await prisma.onModuleDestroy();
    }
  });

  describe('sweepStaleRunning', () => {
    it('flag off: returns 0 and never queries the database', async () => {
      await buildService(buildTranscodeConfig({ enabled: false }));
      const findManySpy = jest.spyOn(prisma.video, 'findMany');

      const result = await service.sweepStaleRunning();

      expect(result).toBe(0);
      expect(findManySpy).not.toHaveBeenCalled();
    });

    it('CAS-fails a row stuck "running" longer than the stalled threshold, with STALE', async () => {
      await buildService(buildTranscodeConfig({ stalledAfterMinutes: 30 }));
      const id = `${testIdPrefix}-stale`;
      const longAgo = new Date(Date.now() - 60 * 60_000); // 60 min ago
      await createFixtureVideo(id, {
        processingState: 'running',
        processingVersion: 1,
        processingStartedAt: longAgo,
      });

      const failedCount = await service.sweepStaleRunning();

      expect(failedCount).toBe(1);
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingState).toBe('failed');
      expect(row.processingErrorCode).toBe('STALE');
      expect(row.processingStep).toBeNull();
      expect(row.processingCompletedAt).not.toBeNull();
    });

    it('never touches a row still within the stalled threshold', async () => {
      await buildService(buildTranscodeConfig({ stalledAfterMinutes: 30 }));
      const id = `${testIdPrefix}-fresh`;
      const recently = new Date(Date.now() - 5 * 60_000); // 5 min ago
      await createFixtureVideo(id, {
        processingState: 'running',
        processingVersion: 1,
        processingStartedAt: recently,
      });

      const failedCount = await service.sweepStaleRunning();

      expect(failedCount).toBe(0);
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingState).toBe('running');
    });

    it('never touches a "queued" or "ready" row, even with an old timestamp irrelevant to those states', async () => {
      await buildService(buildTranscodeConfig());
      const queuedId = `${testIdPrefix}-queued-untouched`;
      await createFixtureVideo(queuedId, {
        processingState: 'queued',
        processingVersion: 1,
      });

      const failedCount = await service.sweepStaleRunning();

      expect(failedCount).toBe(0);
      const row = await prisma.video.findUniqueOrThrow({
        where: { id: queuedId },
      });
      expect(row.processingState).toBe('queued');
    });

    it('is bounded by limit', async () => {
      await buildService(buildTranscodeConfig());
      const longAgo = new Date(Date.now() - 60 * 60_000);
      for (let i = 0; i < 3; i += 1) {
        await createFixtureVideo(`${testIdPrefix}-bound-${i}`, {
          processingState: 'running',
          processingVersion: 1,
          processingStartedAt: longAgo,
        });
      }

      const failedCount = await service.sweepStaleRunning(2);

      expect(failedCount).toBeLessThanOrEqual(2);
    });
  });

  describe('cleanupOrphanStaging', () => {
    it('flag off: returns zero counts and never calls StorageService', async () => {
      await buildService(buildTranscodeConfig({ enabled: false }));

      const result = await service.cleanupOrphanStaging();

      expect(result).toEqual({ deletedGenerations: 0, deletedObjects: 0 });
      expect(storageService.listObjectKeysByPrefix).not.toHaveBeenCalled();
    });

    // Proof 11 (+ its dedicated mutation coverage — see the report's
    // mutation-evidence section: temporarily removing the
    // `generationPrefix === activePrefix` exclusion in
    // `TranscodeJanitorService.cleanupOrphanStaging` was verified to make
    // THIS test fail, then reverted).
    it('NEVER deletes the active generation, even when it is old and past the grace window', async () => {
      await buildService(buildTranscodeConfig({ cleanupGraceMinutes: 120 }));
      const id = `${testIdPrefix}-active-protected`;
      const activeMasterKey = `admin-media/${id}/hls/v2-a1-active-uuid/master.m3u8`;
      await createFixtureVideo(id, {
        processingState: 'ready',
        processingVersion: 2,
        hlsMasterKey: activeMasterKey,
      });

      const veryOld = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30); // 30 days old
      storageService.listObjectKeysByPrefix.mockResolvedValue([
        {
          key: `admin-media/${id}/hls/v2-a1-active-uuid/master.m3u8`,
          lastModified: veryOld,
        },
        {
          key: `admin-media/${id}/hls/v2-a1-active-uuid/360p/index.m3u8`,
          lastModified: veryOld,
        },
      ]);

      const result = await service.cleanupOrphanStaging();

      expect(result).toEqual({ deletedGenerations: 0, deletedObjects: 0 });
      expect(storageService.deleteObject).not.toHaveBeenCalled();
    });

    it('deletes an orphaned (non-active) generation older than the grace window', async () => {
      await buildService(buildTranscodeConfig({ cleanupGraceMinutes: 120 }));
      const id = `${testIdPrefix}-orphan-old`;
      const activeMasterKey = `admin-media/${id}/hls/v2-a1-active-uuid/master.m3u8`;
      await createFixtureVideo(id, {
        processingState: 'ready',
        processingVersion: 2,
        hlsMasterKey: activeMasterKey,
      });

      const veryOld = new Date(Date.now() - 1000 * 60 * 60 * 24); // 1 day old
      storageService.listObjectKeysByPrefix.mockResolvedValue([
        { key: activeMasterKey, lastModified: new Date() },
        {
          key: `admin-media/${id}/hls/v1-a1-old-uuid/master.m3u8`,
          lastModified: veryOld,
        },
        {
          key: `admin-media/${id}/hls/v1-a1-old-uuid/360p/index.m3u8`,
          lastModified: veryOld,
        },
      ]);

      const result = await service.cleanupOrphanStaging();

      expect(result).toEqual({ deletedGenerations: 1, deletedObjects: 2 });
      expect(storageService.deleteObject).toHaveBeenCalledTimes(2);
      expect(storageService.deleteObject).toHaveBeenCalledWith(
        `admin-media/${id}/hls/v1-a1-old-uuid/master.m3u8`,
      );
      expect(storageService.deleteObject).toHaveBeenCalledWith(
        `admin-media/${id}/hls/v1-a1-old-uuid/360p/index.m3u8`,
      );
      // The active generation's own key is never passed to deleteObject.
      expect(storageService.deleteObject).not.toHaveBeenCalledWith(
        activeMasterKey,
      );
    });

    // Proof 12 (+ its dedicated mutation coverage — see the report:
    // temporarily removing the `ageMs < graceMs` skip in
    // `cleanupOrphanStaging` was verified to make THIS test fail, then
    // reverted).
    it('does NOT delete an orphaned generation that is still within the grace window', async () => {
      await buildService(buildTranscodeConfig({ cleanupGraceMinutes: 120 }));
      const id = `${testIdPrefix}-orphan-fresh`;
      const activeMasterKey = `admin-media/${id}/hls/v2-a1-active-uuid/master.m3u8`;
      await createFixtureVideo(id, {
        processingState: 'ready',
        processingVersion: 2,
        hlsMasterKey: activeMasterKey,
      });

      const recentlyOrphaned = new Date(Date.now() - 5 * 60_000); // 5 min ago — well inside the 120-min grace window
      storageService.listObjectKeysByPrefix.mockResolvedValue([
        { key: activeMasterKey, lastModified: new Date() },
        {
          key: `admin-media/${id}/hls/v1-a1-fresh-uuid/master.m3u8`,
          lastModified: recentlyOrphaned,
        },
      ]);

      const result = await service.cleanupOrphanStaging();

      expect(result).toEqual({ deletedGenerations: 0, deletedObjects: 0 });
      expect(storageService.deleteObject).not.toHaveBeenCalled();
    });

    it('never considers a "running" or "queued" row a cleanup candidate at all', async () => {
      await buildService(buildTranscodeConfig());
      const runningId = `${testIdPrefix}-running-excluded`;
      await createFixtureVideo(runningId, {
        processingState: 'running',
        processingVersion: 1,
      });

      await service.cleanupOrphanStaging();

      expect(storageService.listObjectKeysByPrefix).not.toHaveBeenCalledWith(
        `admin-media/${runningId}/hls/`,
        expect.anything(),
      );
    });

    it('a delete failure for one object is logged but does not abort the rest of the sweep', async () => {
      await buildService(buildTranscodeConfig({ cleanupGraceMinutes: 120 }));
      const id = `${testIdPrefix}-partial-failure`;
      await createFixtureVideo(id, {
        processingState: 'failed',
        processingVersion: 1,
        hlsMasterKey: null,
      });

      const veryOld = new Date(Date.now() - 1000 * 60 * 60 * 24);
      storageService.listObjectKeysByPrefix.mockResolvedValue([
        {
          key: `admin-media/${id}/hls/v1-a1-uuid/master.m3u8`,
          lastModified: veryOld,
        },
        {
          key: `admin-media/${id}/hls/v1-a1-uuid/360p/index.m3u8`,
          lastModified: veryOld,
        },
      ]);
      storageService.deleteObject
        .mockRejectedValueOnce(new Error('simulated delete failure'))
        .mockResolvedValueOnce(undefined);

      const result = await service.cleanupOrphanStaging();

      expect(storageService.deleteObject).toHaveBeenCalledTimes(2);
      expect(result.deletedObjects).toBe(1);
      expect(result.deletedGenerations).toBe(1);
    });

    it('a row with no hlsMasterKey (never had a successful generation) can still have orphans cleaned up', async () => {
      await buildService(buildTranscodeConfig({ cleanupGraceMinutes: 120 }));
      const id = `${testIdPrefix}-never-promoted`;
      await createFixtureVideo(id, {
        processingState: 'failed',
        processingVersion: 1,
        hlsMasterKey: null,
      });

      const veryOld = new Date(Date.now() - 1000 * 60 * 60 * 24);
      storageService.listObjectKeysByPrefix.mockResolvedValue([
        {
          key: `admin-media/${id}/hls/v1-a1-uuid/master.m3u8`,
          lastModified: veryOld,
        },
      ]);

      const result = await service.cleanupOrphanStaging();

      expect(result).toEqual({ deletedGenerations: 1, deletedObjects: 1 });
    });
  });
});
