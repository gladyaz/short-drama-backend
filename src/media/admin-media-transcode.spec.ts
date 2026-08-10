import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { TranscodeIntentService } from '../transcode/transcode-intent.service';
import { TRANSCODE_QUEUE, TranscodeQueue } from '../transcode/transcode.types';
import { AdminMediaService } from './admin-media.service';
import { MediaLifecycleService } from './media-lifecycle.service';

/**
 * Slice 11N — unit-level coverage of the guarded enqueue point in
 * `AdminMediaService.completeUpload`. Deliberately a SEPARATE file from
 * `admin-media.service.spec.ts` (which stays completely unmodified — proof
 * 5, "existing complete-upload behavior remains valid"). `PrismaService` is
 * the real client against the project's Postgres TEST database (matching
 * that file's own precedent), self-cleaning via `afterEach`. `TranscodeQueue`
 * is always a jest mock — no real Redis connection anywhere in this file.
 */
describe('AdminMediaService — Slice 11N transcode enqueue wiring', () => {
  let service: AdminMediaService;
  let prisma: PrismaService;
  let storageService: {
    createPresignedPutUrl: jest.Mock;
    headObject: jest.Mock;
  };
  let queue: { add: jest.Mock };

  const testIdPrefix = 'admin-media-transcode-spec-11n';

  const EXPECTED_SIZE_BYTES = 2048;
  const baseDto = {
    seriesId: `${testIdPrefix}-series`,
    title: 'Spec Media',
    episodeNumber: 1,
    channelName: 'Spec Channel',
    caption: 'Spec caption',
    category: 'drama',
    sourceLanguage: 'zh',
    hasEmbeddedIndonesianSubtitle: true,
    sizeBytes: EXPECTED_SIZE_BYTES,
    contentType: 'video/mp4' as const,
  };

  async function buildService(transcodeEnabled: boolean): Promise<void> {
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
    queue = { add: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminMediaService,
        MediaLifecycleService,
        PrismaService,
        TranscodeIntentService,
        { provide: StorageService, useValue: storageService },
        { provide: TRANSCODE_QUEUE, useValue: queue as TranscodeQueue },
        {
          provide: ConfigService,
          useValue: {
            get: (key: 'transcode') =>
              key === 'transcode'
                ? { enabled: transcodeEnabled, redisUrl: undefined }
                : undefined,
          },
        },
      ],
    }).compile();

    service = module.get<AdminMediaService>(AdminMediaService);
    prisma = module.get<PrismaService>(PrismaService);
    await prisma.onModuleInit();
  }

  afterEach(async () => {
    await prisma.video.deleteMany({
      where: { seriesId: baseDto.seriesId },
    });
    await prisma.onModuleDestroy();
  });

  it('flag ON: calls requestProcessing exactly once after a successful complete-upload, with the correct videoId', async () => {
    await buildService(true);

    const created = await service.createUpload(baseDto);
    const id = created.media.id;

    const result = await service.completeUpload(id, {});

    expect(result.lifecycleState).toBe('ready');
    expect(queue.add).toHaveBeenCalledTimes(1);
    const [jobId, payload] = queue.add.mock.calls[0] as [
      string,
      { videoId: string; processingVersion: number },
    ];
    expect(jobId).toBe(`${id}:1`);
    expect(payload).toEqual({ videoId: id, processingVersion: 1 });

    const row = await prisma.video.findUniqueOrThrow({ where: { id } });
    expect(row.processingState).toBe('queued');
    expect(row.processingVersion).toBe(1);
  });

  it('flag OFF: never calls requestProcessing, and the row keeps processingState null / processingVersion 0', async () => {
    await buildService(false);

    const created = await service.createUpload(baseDto);
    const id = created.media.id;

    const result = await service.completeUpload(id, {});

    expect(result.lifecycleState).toBe('ready');
    expect(queue.add).not.toHaveBeenCalled();

    const row = await prisma.video.findUniqueOrThrow({ where: { id } });
    expect(row.processingState).toBeNull();
    expect(row.processingVersion).toBe(0);
  });

  it('flag ON: a queue enqueue failure does not fail completeUpload — the upload still succeeds', async () => {
    await buildService(true);
    queue.add.mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:6379'));

    const created = await service.createUpload(baseDto);
    const id = created.media.id;

    await expect(service.completeUpload(id, {})).resolves.toMatchObject({
      lifecycleState: 'ready',
    });

    const row = await prisma.video.findUniqueOrThrow({ where: { id } });
    // requestProcessing's own DB write (increment + "queued") already
    // succeeded before the enqueue attempt failed — see its doc comment.
    expect(row.processingState).toBe('queued');
    expect(row.processingVersion).toBe(1);
  });
});
