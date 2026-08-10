import { Test, TestingModule } from '@nestjs/testing';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { AdminMediaService } from './admin-media.service';
import { CreateMediaUploadDto } from './dto/create-media-upload.dto';
import { MediaLifecycleService } from './media-lifecycle.service';

/**
 * Slice 11P — proofs 13, 14, 15: the publish gate (2026-08-10 approval,
 * binding constraint 10). Deliberately does NOT wire `ConfigModule`/
 * `TranscodeModule` (mirrors `admin-media.service.spec.ts`'s bare-providers
 * shape) — `TRANSCODE_ENABLED` plays no role in this gate at all; it is
 * checked purely off the row's own `processingState`/`hlsMasterKey` columns,
 * which this file writes directly via `prisma.video.update` to simulate
 * every stage a real `TranscodeJobProcessor` run would produce, without
 * depending on that (separately tested) worker code.
 */
describe('AdminMediaService — Slice 11P publish gate (proofs 13/14/15)', () => {
  let service: AdminMediaService;
  let prisma: PrismaService;
  let storageService: {
    createPresignedPutUrl: jest.Mock;
    headObject: jest.Mock;
  };

  const testIdPrefix = 'admin-media-publish-gate-spec-11p';

  const EXPECTED_SIZE_BYTES = 2048;
  let episodeCounter = 1;

  function nextDto(): CreateMediaUploadDto {
    episodeCounter += 1;
    return {
      seriesId: `${testIdPrefix}-series`,
      title: 'Spec Media',
      episodeNumber: episodeCounter,
      channelName: 'Spec Channel',
      caption: 'Spec caption',
      category: 'drama',
      sourceLanguage: 'zh',
      hasEmbeddedIndonesianSubtitle: true,
      sizeBytes: EXPECTED_SIZE_BYTES,
      contentType: 'video/mp4',
    };
  }

  beforeEach(async () => {
    storageService = {
      createPresignedPutUrl: jest.fn().mockResolvedValue({
        url: 'https://signed.example.test/put',
        key: 'admin-media/mock/source',
        expiresAt: new Date(Date.now() + 60_000),
      }),
      headObject: jest.fn().mockResolvedValue({
        key: 'admin-media/mock/source',
        contentLength: EXPECTED_SIZE_BYTES,
        contentType: 'video/mp4',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminMediaService,
        MediaLifecycleService,
        PrismaService,
        { provide: StorageService, useValue: storageService },
      ],
    }).compile();

    service = module.get<AdminMediaService>(AdminMediaService);
    prisma = module.get<PrismaService>(PrismaService);
    await prisma.onModuleInit();
  });

  afterEach(async () => {
    await prisma.video.deleteMany({
      where: { seriesId: `${testIdPrefix}-series` },
    });
    await prisma.onModuleDestroy();
  });

  async function createReadyMedia(): Promise<string> {
    const created = await service.createUpload(nextDto());
    await service.completeUpload(created.media.id, {});
    return created.media.id;
  }

  describe('proof 13: publish blocked before HLS ready (processingState non-null rows)', () => {
    it('rejects publish with 409 HLS_NOT_READY_FOR_PUBLISH when processingState is "queued"', async () => {
      const id = await createReadyMedia();
      await prisma.video.update({
        where: { id },
        data: { processingState: 'queued', processingVersion: 1 },
      });

      let caught: unknown;
      try {
        await service.publish(id);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AppException);
      expect((caught as AppException).code).toBe(
        AppErrorCode.HLS_NOT_READY_FOR_PUBLISH,
      );
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.lifecycleState).toBe('ready'); // unchanged, publish refused
    });

    it('rejects publish when processingState is "running"', async () => {
      const id = await createReadyMedia();
      await prisma.video.update({
        where: { id },
        data: { processingState: 'running', processingVersion: 1 },
      });

      await expect(service.publish(id)).rejects.toMatchObject({
        code: AppErrorCode.HLS_NOT_READY_FOR_PUBLISH,
      });
    });

    it('rejects publish when processingState is "failed"', async () => {
      const id = await createReadyMedia();
      await prisma.video.update({
        where: { id },
        data: { processingState: 'failed', processingVersion: 1 },
      });

      await expect(service.publish(id)).rejects.toMatchObject({
        code: AppErrorCode.HLS_NOT_READY_FOR_PUBLISH,
      });
    });

    it('rejects publish when processingState is "ready" but hlsMasterKey is still null', async () => {
      const id = await createReadyMedia();
      await prisma.video.update({
        where: { id },
        data: {
          processingState: 'ready',
          processingVersion: 1,
          hlsMasterKey: null,
        },
      });

      await expect(service.publish(id)).rejects.toMatchObject({
        code: AppErrorCode.HLS_NOT_READY_FOR_PUBLISH,
      });
    });
  });

  describe('proof 14: publish allowed after verified ready', () => {
    it('publishes successfully once processingState is "ready" AND hlsMasterKey is set', async () => {
      const id = await createReadyMedia();
      await prisma.video.update({
        where: { id },
        data: {
          processingState: 'ready',
          processingVersion: 1,
          hlsMasterKey: `admin-media/${id}/hls/v1-a1-uuid/master.m3u8`,
        },
      });

      const result = await service.publish(id);

      expect(result.lifecycleState).toBe('published');
    });
  });

  describe('proof 15: legacy/local rows (processingState null) unaffected — byte-identical regression', () => {
    it('publishes a row with processingState null and no hlsMasterKey, exactly like before this slice', async () => {
      const id = await createReadyMedia();
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingState).toBeNull();
      expect(row.hlsMasterKey).toBeNull();

      const result = await service.publish(id);

      expect(result.lifecycleState).toBe('published');
    });

    it('unpublish/republish also stay unaffected for a processingState-null row', async () => {
      const id = await createReadyMedia();
      await service.publish(id);

      const unpublished = await service.unpublish(id);
      expect(unpublished.lifecycleState).toBe('unpublished');

      const republished = await service.publish(id);
      expect(republished.lifecycleState).toBe('published');
    });

    it('the pre-HLS published R2 fixture shape (processingState null, published already) is never touched by the gate', async () => {
      // Simulates a row that predates the HLS pipeline entirely — created,
      // completed, and published, with processingState/hlsMasterKey left at
      // their additive-migration backfill values (null) the whole time.
      const id = await createReadyMedia();
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingState).toBeNull();

      await expect(service.publish(id)).resolves.toMatchObject({
        lifecycleState: 'published',
      });
    });
  });
});
