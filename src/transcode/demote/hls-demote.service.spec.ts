import { Test, TestingModule } from '@nestjs/testing';
import { fixtureMarker } from '../../common/testing/fixture-namespace.helpers';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { TranscodeIntentService } from '../transcode-intent.service';
import { HlsDemoteService } from './hls-demote.service';

/**
 * Work unit "HLS DEMOTE". `PrismaService` is the REAL client against the
 * project's Postgres test database — the point of this suite is the
 * compare-and-set semantics of a real `updateMany`, which a mocked Prisma
 * would assert nothing about. `StorageService` is entirely mocked; no real
 * R2/network call is made, and the mock records every call so "this command
 * never deletes anything" is proven by construction rather than asserted by
 * reading the source.
 */
describe('HlsDemoteService', () => {
  let service: HlsDemoteService;
  let prisma: PrismaService;
  let storageService: {
    headObject: jest.Mock;
    deleteObject: jest.Mock;
    listObjectKeysByPrefix: jest.Mock;
    createPresignedGetUrl: jest.Mock;
  };

  const testIdPrefix = fixtureMarker('hls-demote-spec');
  const seriesId = `${testIdPrefix}-series`;

  /** The exact shape `TranscodeIntentService.promoteIfCurrent` writes. */
  function masterKeyFor(id: string, version: number, attempt = 1): string {
    return `admin-media/${id}/hls/v${version}-a${attempt}-11111111-2222-3333-4444-555555555555/master.m3u8`;
  }

  const renditions = [
    { name: '360p', width: 360, height: 640, bandwidth: 800_000 },
    { name: '540p', width: 540, height: 960, bandwidth: 1_400_000 },
    { name: '720p', width: 720, height: 1280, bandwidth: 2_800_000 },
  ];

  async function createPromotedVideo(
    id: string,
    overrides: Partial<{
      processingState: string | null;
      processingVersion: number;
      hlsMasterKey: string | null;
      hlsRenditions: unknown;
      objectStorageKey: string | null;
      storageKey: string;
    }> = {},
  ): Promise<void> {
    const processingVersion = overrides.processingVersion ?? 3;

    await prisma.video.create({
      data: {
        id,
        seriesId,
        title: 'Fixture',
        episodeNumber: 1,
        channelName: 'Fixture Channel',
        caption: 'Fixture caption',
        category: 'drama',
        storageKey: overrides.storageKey ?? '',
        sourceLanguage: 'zh',
        hasEmbeddedIndonesianSubtitle: true,
        likeCount: 0,
        lifecycleState: 'published',
        objectStorageKey:
          overrides.objectStorageKey === undefined
            ? `admin-media/${id}/source`
            : overrides.objectStorageKey,
        processingState:
          overrides.processingState === undefined
            ? 'ready'
            : overrides.processingState,
        processingVersion,
        processingAttempts: 1,
        hlsMasterKey:
          overrides.hlsMasterKey === undefined
            ? masterKeyFor(id, processingVersion)
            : overrides.hlsMasterKey,
        hlsRenditions: (overrides.hlsRenditions ?? renditions) as never,
        transcodeProfileVersion: 'ladder-v1',
      },
    });
  }

  beforeEach(async () => {
    storageService = {
      // A present, non-empty source object is the default fixture reality.
      headObject: jest.fn().mockResolvedValue({ contentLength: 12_345 }),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      listObjectKeysByPrefix: jest.fn().mockResolvedValue([]),
      createPresignedGetUrl: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HlsDemoteService,
        PrismaService,
        { provide: StorageService, useValue: storageService },
      ],
    }).compile();

    service = module.get(HlsDemoteService);
    prisma = module.get(PrismaService);
    await prisma.onModuleInit();
  });

  afterEach(async () => {
    if (prisma) {
      await prisma.video.deleteMany({ where: { seriesId } });
      await prisma.onModuleDestroy();
    }
  });

  describe('dry run (the default)', () => {
    it('makes zero database writes and reports exactly what would stop being advertised', async () => {
      const id = `${testIdPrefix}-dry`;
      await createPromotedVideo(id);
      const updateManySpy = jest.spyOn(prisma.video, 'updateMany');
      const updateSpy = jest.spyOn(prisma.video, 'update');

      const report = await service.run({
        videoId: id,
        expectedGeneration: 3,
        apply: false,
        allowUnplayable: false,
      });

      expect(updateManySpy).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
      expect(report.demoted).toBe(false);
      expect(report.refusal).toBeUndefined();
      expect(report.plan?.masterKey).toBe(masterKeyFor(id, 3));
      expect(report.plan?.generationPrefix).toBe(
        `admin-media/${id}/hls/v3-a1-11111111-2222-3333-4444-555555555555/`,
      );
      expect(report.plan?.renditions.map((r) => r.name)).toEqual([
        '360p',
        '540p',
        '720p',
      ]);

      // The row is byte-identical to before the call.
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingState).toBe('ready');
      expect(row.hlsMasterKey).toBe(masterKeyFor(id, 3));
      expect(row.hlsRenditions).not.toBeNull();
      expect(row.transcodeProfileVersion).toBe('ladder-v1');
      expect(row.processingErrorCode).toBeNull();
    });

    it('reports the truthful post-demotion playback source (R2 MP4), including whether it really exists', async () => {
      const id = `${testIdPrefix}-fallback-r2`;
      await createPromotedVideo(id);

      const report = await service.run({
        videoId: id,
        expectedGeneration: 3,
        apply: false,
        allowUnplayable: false,
      });

      expect(report.plan?.resultingPlayback).toEqual({
        kind: 'r2',
        objectStorageKey: `admin-media/${id}/source`,
        sourceObjectPresent: true,
      });
      expect(storageService.headObject).toHaveBeenCalledWith(
        `admin-media/${id}/source`,
      );
    });

    it('reports the local /stream fallback for a row with no object storage key', async () => {
      const id = `${testIdPrefix}-fallback-local`;
      await createPromotedVideo(id, {
        objectStorageKey: null,
        storageKey: 'Series 104/1_subtitled.mp4',
      });

      const report = await service.run({
        videoId: id,
        expectedGeneration: 3,
        apply: false,
        allowUnplayable: false,
      });

      expect(report.plan?.resultingPlayback).toEqual({
        kind: 'local',
        storageKey: 'Series 104/1_subtitled.mp4',
      });
      // No storage call at all for a purely local row.
      expect(storageService.headObject).not.toHaveBeenCalled();
    });
  });

  describe('apply', () => {
    it('demotes exactly the intended generation and clears the three promotion columns together', async () => {
      const id = `${testIdPrefix}-apply`;
      await createPromotedVideo(id);

      const report = await service.run({
        videoId: id,
        expectedGeneration: 3,
        apply: true,
        allowUnplayable: false,
      });

      expect(report.demoted).toBe(true);
      expect(report.refusal).toBeUndefined();

      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.hlsMasterKey).toBeNull();
      expect(row.hlsRenditions).toBeNull();
      expect(row.transcodeProfileVersion).toBeNull();
      expect(row.processingState).toBe('failed');
      expect(row.processingErrorCode).toBe('DEMOTED');
      expect(row.processingStep).toBeNull();
      expect(row.processingCompletedAt).not.toBeNull();
      // The error message records WHICH generation was demoted, as an audit
      // trail — it is not restorable state and nothing reads it back.
      expect(row.processingErrorMessage).toContain(masterKeyFor(id, 3));
    });

    it('leaves the source MP4 columns and the version counter untouched', async () => {
      const id = `${testIdPrefix}-source-safe`;
      await createPromotedVideo(id, {
        storageKey: 'Series 104/1_subtitled.mp4',
      });

      await service.run({
        videoId: id,
        expectedGeneration: 3,
        apply: true,
        allowUnplayable: false,
      });

      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.objectStorageKey).toBe(`admin-media/${id}/source`);
      expect(row.storageKey).toBe('Series 104/1_subtitled.mp4');
      expect(row.processingVersion).toBe(3);
      expect(row.lifecycleState).toBe('published');
    });

    it('never deletes, lists or writes any object — the demoted generation stays in storage', async () => {
      const id = `${testIdPrefix}-no-delete`;
      await createPromotedVideo(id);

      await service.run({
        videoId: id,
        expectedGeneration: 3,
        apply: true,
        allowUnplayable: false,
      });

      expect(storageService.deleteObject).not.toHaveBeenCalled();
      expect(storageService.listObjectKeysByPrefix).not.toHaveBeenCalled();
      // The ONLY storage call this command may ever make is a read-only HEAD
      // of the fallback source object.
      expect(storageService.headObject).toHaveBeenCalledTimes(1);
      expect(storageService.headObject).toHaveBeenCalledWith(
        `admin-media/${id}/source`,
      );
    });

    it("does not touch another video's HLS state", async () => {
      const target = `${testIdPrefix}-target`;
      const bystander = `${testIdPrefix}-bystander`;
      await createPromotedVideo(target);
      await createPromotedVideo(bystander);

      await service.run({
        videoId: target,
        expectedGeneration: 3,
        apply: true,
        allowUnplayable: false,
      });

      const other = await prisma.video.findUniqueOrThrow({
        where: { id: bystander },
      });
      expect(other.hlsMasterKey).toBe(masterKeyFor(bystander, 3));
      expect(other.processingState).toBe('ready');
      expect(other.hlsRenditions).not.toBeNull();
    });

    it('is cleanly rejected when repeated — the second run finds nothing advertised', async () => {
      const id = `${testIdPrefix}-idempotent`;
      await createPromotedVideo(id);

      const first = await service.run({
        videoId: id,
        expectedGeneration: 3,
        apply: true,
        allowUnplayable: false,
      });
      const rowAfterFirst = await prisma.video.findUniqueOrThrow({
        where: { id },
      });

      const second = await service.run({
        videoId: id,
        expectedGeneration: 3,
        apply: true,
        allowUnplayable: false,
      });
      const rowAfterSecond = await prisma.video.findUniqueOrThrow({
        where: { id },
      });

      expect(first.demoted).toBe(true);
      expect(second.demoted).toBe(false);
      expect(second.refusal?.code).toBe('NO_ACTIVE_HLS_GENERATION');
      // Byte-identical: the second run wrote nothing, not even a timestamp.
      expect(rowAfterSecond).toEqual(rowAfterFirst);
    });
  });

  describe('safety gates — every one of these performs ZERO mutation', () => {
    it('refuses an unknown video id', async () => {
      const report = await service.run({
        videoId: `${testIdPrefix}-does-not-exist`,
        expectedGeneration: 3,
        apply: true,
        allowUnplayable: false,
      });

      expect(report.refusal?.code).toBe('ROW_NOT_FOUND');
      expect(report.demoted).toBe(false);
      expect(report.plan).toBeUndefined();
    });

    it('refuses a STALE generation — an older version than the row currently carries', async () => {
      const id = `${testIdPrefix}-stale-command`;
      await createPromotedVideo(id, { processingVersion: 5 });

      const report = await service.run({
        videoId: id,
        expectedGeneration: 3,
        apply: true,
        allowUnplayable: false,
      });

      expect(report.refusal?.code).toBe('GENERATION_MISMATCH');
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.hlsMasterKey).toBe(masterKeyFor(id, 5));
      expect(row.processingState).toBe('ready');
    });

    it('a NEWER generation wins: a stale command can never demote the generation that superseded it', async () => {
      const id = `${testIdPrefix}-newer-wins`;
      await createPromotedVideo(id, { processingVersion: 3 });

      // v4 promotes, exactly as `promoteIfCurrent` would leave the row.
      await prisma.video.update({
        where: { id },
        data: {
          processingVersion: 4,
          hlsMasterKey: masterKeyFor(id, 4),
          processingState: 'ready',
        },
      });

      const report = await service.run({
        videoId: id,
        expectedGeneration: 3,
        apply: true,
        allowUnplayable: false,
      });

      expect(report.refusal?.code).toBe('GENERATION_MISMATCH');
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.hlsMasterKey).toBe(masterKeyFor(id, 4));
      expect(row.processingVersion).toBe(4);
    });

    it('refuses a row that is not "ready" (a re-transcode is in flight)', async () => {
      const id = `${testIdPrefix}-running`;
      await createPromotedVideo(id, { processingState: 'running' });

      const report = await service.run({
        videoId: id,
        expectedGeneration: 3,
        apply: true,
        allowUnplayable: false,
      });

      expect(report.refusal?.code).toBe('NOT_READY');
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingState).toBe('running');
      expect(row.hlsMasterKey).toBe(masterKeyFor(id, 3));
    });

    it('refuses a row the HLS pipeline has never touched', async () => {
      const id = `${testIdPrefix}-legacy`;
      await createPromotedVideo(id, {
        processingState: null,
        hlsMasterKey: null,
        processingVersion: 0,
      });

      const report = await service.run({
        videoId: id,
        expectedGeneration: 0,
        apply: true,
        allowUnplayable: false,
      });

      expect(report.refusal?.code).toBe('NOT_AN_HLS_PIPELINE_ROW');
    });

    it('refuses when the live pointer belongs to a different generation than the version column', async () => {
      const id = `${testIdPrefix}-pointer-mismatch`;
      await createPromotedVideo(id, {
        processingVersion: 3,
        hlsMasterKey: masterKeyFor(id, 2),
      });

      const report = await service.run({
        videoId: id,
        expectedGeneration: 3,
        apply: true,
        allowUnplayable: false,
      });

      expect(report.refusal?.code).toBe('GENERATION_POINTER_MISMATCH');
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.hlsMasterKey).toBe(masterKeyFor(id, 2));
    });

    it("refuses a pointer that does not live under this video's own home prefix", async () => {
      const id = `${testIdPrefix}-foreign-key`;
      await createPromotedVideo(id, {
        hlsMasterKey: masterKeyFor(`${testIdPrefix}-someone-else`, 3),
      });

      const report = await service.run({
        videoId: id,
        expectedGeneration: 3,
        apply: true,
        allowUnplayable: false,
      });

      expect(report.refusal?.code).toBe('MASTER_KEY_FOREIGN');
    });

    it('refuses when demoting would leave the row with no playable source at all', async () => {
      const id = `${testIdPrefix}-no-fallback`;
      await createPromotedVideo(id, {
        objectStorageKey: null,
        storageKey: '',
      });

      const report = await service.run({
        videoId: id,
        expectedGeneration: 3,
        apply: true,
        allowUnplayable: false,
      });

      expect(report.refusal?.code).toBe('NO_PLAYBACK_FALLBACK');
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.hlsMasterKey).toBe(masterKeyFor(id, 3));
    });

    it('refuses when the fallback source object is missing from storage', async () => {
      const id = `${testIdPrefix}-missing-source`;
      await createPromotedVideo(id);
      storageService.headObject.mockResolvedValue(null);

      const report = await service.run({
        videoId: id,
        expectedGeneration: 3,
        apply: true,
        allowUnplayable: false,
      });

      expect(report.refusal?.code).toBe('NO_PLAYBACK_FALLBACK');
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingState).toBe('ready');
    });

    it('--allow-unplayable is the deliberate escape hatch for a row with no fallback', async () => {
      const id = `${testIdPrefix}-allow-unplayable`;
      await createPromotedVideo(id, {
        objectStorageKey: null,
        storageKey: '',
      });

      const report = await service.run({
        videoId: id,
        expectedGeneration: 3,
        apply: true,
        allowUnplayable: true,
      });

      expect(report.demoted).toBe(true);
      expect(report.plan?.resultingPlayback).toEqual({ kind: 'unavailable' });
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.hlsMasterKey).toBeNull();
    });
  });

  describe('concurrency', () => {
    it('CAS-loses (and writes nothing) when a newer generation promotes between the read and the write', async () => {
      const id = `${testIdPrefix}-cas-race`;
      await createPromotedVideo(id, { processingVersion: 3 });

      // The read-only source HEAD happens AFTER the row is read and BEFORE
      // the guarded write — the exact window a competing promotion would
      // land in. Racing inside it is a real interleaving, not a simulated
      // one.
      storageService.headObject.mockImplementation(async () => {
        await prisma.video.update({
          where: { id },
          data: {
            processingVersion: 4,
            hlsMasterKey: masterKeyFor(id, 4),
          },
        });
        return { contentLength: 12_345 };
      });

      const report = await service.run({
        videoId: id,
        expectedGeneration: 3,
        apply: true,
        allowUnplayable: false,
      });

      expect(report.demoted).toBe(false);
      expect(report.refusal?.code).toBe('CAS_LOST');

      // The winner's generation is completely intact.
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingVersion).toBe(4);
      expect(row.hlsMasterKey).toBe(masterKeyFor(id, 4));
      expect(row.processingState).toBe('ready');
      expect(row.processingErrorCode).toBeNull();
    });

    it('CAS-loses when the pointer alone changes, even at an unchanged version', async () => {
      const id = `${testIdPrefix}-cas-pointer`;
      await createPromotedVideo(id, { processingVersion: 3 });

      storageService.headObject.mockImplementation(async () => {
        await prisma.video.update({
          where: { id },
          data: { hlsMasterKey: masterKeyFor(id, 3, 2) },
        });
        return { contentLength: 12_345 };
      });

      const report = await service.run({
        videoId: id,
        expectedGeneration: 3,
        apply: true,
        allowUnplayable: false,
      });

      expect(report.refusal?.code).toBe('CAS_LOST');
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.hlsMasterKey).toBe(masterKeyFor(id, 3, 2));
      expect(row.processingState).toBe('ready');
    });

    it('a storage failure during the pre-flight check aborts before any write', async () => {
      const id = `${testIdPrefix}-head-throws`;
      await createPromotedVideo(id);
      storageService.headObject.mockRejectedValue(new Error('R2 unreachable'));

      await expect(
        service.run({
          videoId: id,
          expectedGeneration: 3,
          apply: true,
          allowUnplayable: false,
        }),
      ).rejects.toThrow('R2 unreachable');

      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingState).toBe('ready');
      expect(row.hlsMasterKey).toBe(masterKeyFor(id, 3));
    });
  });

  describe('after a demotion', () => {
    it('the demoted generation can never be re-advertised by a late promotion of its own version', async () => {
      const id = `${testIdPrefix}-no-reanimation`;
      await createPromotedVideo(id);
      const demotedKey = masterKeyFor(id, 3);

      await service.run({
        videoId: id,
        expectedGeneration: 3,
        apply: true,
        allowUnplayable: false,
      });

      // A worker still holding v3 tries to promote the very generation that
      // was just demoted. `promoteIfCurrent` is state-guarded on "running",
      // and the row is now "failed" — zero rows match.
      const intent = new TranscodeIntentService(prisma, {
        add: jest.fn(),
      });
      const promoted = await intent.promoteIfCurrent(id, 3, {
        hlsMasterKey: demotedKey,
        hlsRenditions: renditions,
        transcodeProfileVersion: 'ladder-v1',
      });

      expect(promoted).toBe(0);
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.hlsMasterKey).toBeNull();
      expect(row.processingState).toBe('failed');
    });
  });
});
