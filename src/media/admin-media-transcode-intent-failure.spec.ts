import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { TranscodeIntentService } from '../transcode/transcode-intent.service';
import { AdminMediaService } from './admin-media.service';
import { MediaLifecycleService } from './media-lifecycle.service';

/**
 * Slice 11P — proof 1: "durable-intent failure not swallowed (tx aborts,
 * explicit error, no ready-without-queued)". This is the dedicated
 * regression coverage for the carried 11N/11O REQUIRED concern the
 * 2026-08-10 Slice 11P approval mandated resolving (binding constraint 5) —
 * deliberately a SEPARATE file from `admin-media-transcode.spec.ts` (11N's
 * happy-path enqueue-wiring coverage, left completely unmodified) and from
 * `admin-media.service.spec.ts` (the pre-existing complete-upload specs,
 * also left completely unmodified — proof 15/16).
 *
 * `TranscodeIntentService` is REPLACED with a hand-built mock whose
 * `recordIntent` always rejects, so `AdminMediaService.completeUpload`'s new
 * `prisma.$transaction(...)` callback throws mid-transaction — proving the
 * whole transaction (including the `tx.video.update` ready-transition that
 * ran just before it, inside the SAME transaction) rolls back. `PrismaService`
 * is the real client against the project's Postgres TEST database (matching
 * every other spec in this module); `StorageService` stays entirely mocked.
 */
describe('AdminMediaService — Slice 11P proof 1: durable-intent failure is not swallowed', () => {
  let service: AdminMediaService;
  let prisma: PrismaService;
  let storageService: {
    createPresignedPutUrl: jest.Mock;
    headObject: jest.Mock;
  };
  let mockIntentService: {
    recordIntent: jest.Mock;
    enqueueBestEffort: jest.Mock;
  };

  const testIdPrefix = 'admin-media-intent-failure-spec-11p';

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
    mockIntentService = {
      recordIntent: jest
        .fn()
        .mockRejectedValue(new Error('simulated database outage')),
      enqueueBestEffort: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminMediaService,
        MediaLifecycleService,
        PrismaService,
        { provide: StorageService, useValue: storageService },
        { provide: TranscodeIntentService, useValue: mockIntentService },
        {
          provide: ConfigService,
          useValue: {
            get: (key: 'transcode') =>
              key === 'transcode'
                ? { enabled: true, redisUrl: 'redis://localhost:6379' }
                : undefined,
          },
        },
      ],
    }).compile();

    service = module.get<AdminMediaService>(AdminMediaService);
    prisma = module.get<PrismaService>(PrismaService);
    await prisma.onModuleInit();
  });

  afterEach(async () => {
    await prisma.video.deleteMany({
      where: { seriesId: baseDto.seriesId },
    });
    await prisma.onModuleDestroy();
  });

  it('throws MEDIA_PROCESSING_INTENT_FAILED (not a swallowed warning) when the durable intent write fails', async () => {
    const created = await service.createUpload(baseDto);
    const id = created.media.id;

    let caught: unknown;
    try {
      await service.completeUpload(id, {});
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppException);
    expect((caught as AppException).code).toBe(
      AppErrorCode.MEDIA_PROCESSING_INTENT_FAILED,
    );
  });

  it('rolls back the ENTIRE transaction — the row stays "draft", never "ready" (no ready-without-queued state)', async () => {
    const created = await service.createUpload(baseDto);
    const id = created.media.id;

    await expect(service.completeUpload(id, {})).rejects.toThrow();

    const row = await prisma.video.findUniqueOrThrow({ where: { id } });
    expect(row.lifecycleState).toBe('draft');
    expect(row.processingState).toBeNull();
    expect(row.processingVersion).toBe(0);
  });

  it('never calls enqueueBestEffort — no job is ever enqueued for a request whose intent was never durably recorded', async () => {
    const created = await service.createUpload(baseDto);
    const id = created.media.id;

    await expect(service.completeUpload(id, {})).rejects.toThrow();

    expect(mockIntentService.enqueueBestEffort).not.toHaveBeenCalled();
  });

  it('the completion call can be retried once the underlying issue is resolved (no permanent stuck state)', async () => {
    const created = await service.createUpload(baseDto);
    const id = created.media.id;

    await expect(service.completeUpload(id, {})).rejects.toThrow();

    // Simulate the underlying issue being resolved.
    mockIntentService.recordIntent.mockResolvedValueOnce(1);

    const result = await service.completeUpload(id, {});

    expect(result.lifecycleState).toBe('ready');
    const row = await prisma.video.findUniqueOrThrow({ where: { id } });
    expect(row.lifecycleState).toBe('ready');
  });
});
