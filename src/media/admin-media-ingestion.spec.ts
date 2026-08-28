import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { TranscodeIntentService } from '../transcode/transcode-intent.service';
import { buildTranscodeJobId } from '../transcode/transcode.constants';
import { TRANSCODE_QUEUE, TranscodeQueue } from '../transcode/transcode.types';
import { AdminMediaService } from './admin-media.service';
import { MediaLifecycleService } from './media-lifecycle.service';
import { buildSourceObjectKey } from './media-storage-key.util';

/**
 * Work unit "ADMIN MEDIA INGESTION": service-level coverage of the ingestion
 * pipeline's new surfaces — the hardened `complete-upload` checks (zero-byte
 * object, source-key ownership), the admin status contract, and the
 * `retry-transcode` action.
 *
 * `PrismaService` is the real client against this worktree's Postgres
 * database (matching the existing `admin-media.service.spec.ts` /
 * `admin-media-transcode.spec.ts` precedent), self-cleaning via `afterEach`.
 * `StorageService` is ALWAYS a jest mock and `TRANSCODE_QUEUE` is ALWAYS a
 * jest mock: no test in this file makes a real R2/S3 call, mutates a real
 * object, or opens a Redis connection.
 */
describe('AdminMediaService — admin media ingestion', () => {
  let service: AdminMediaService;
  let prisma: PrismaService;
  let storageService: {
    createPresignedPutUrl: jest.Mock;
    headObject: jest.Mock;
  };
  let queue: { add: jest.Mock };

  const testIdPrefix = 'admin-media-ingestion-spec';
  const EXPECTED_SIZE_BYTES = 2048;

  const baseDto = {
    seriesId: `${testIdPrefix}-series`,
    title: 'Ingestion Spec Media',
    episodeNumber: 1,
    channelName: 'Spec Channel',
    caption: 'Spec caption',
    category: 'drama',
    sourceLanguage: 'zh',
    hasEmbeddedIndonesianSubtitle: true,
    sizeBytes: EXPECTED_SIZE_BYTES,
    contentType: 'video/mp4' as const,
  };

  const MAX_ATTEMPTS = 3;

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
                ? {
                    enabled: transcodeEnabled,
                    redisUrl: undefined,
                    maxAttempts: MAX_ATTEMPTS,
                  }
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
    await prisma.video.deleteMany({ where: { seriesId: baseDto.seriesId } });
    await prisma.onModuleDestroy();
  });

  /** Creates a draft and completes it, leaving a `ready` + `queued` row. */
  async function createCompletedMedia(): Promise<string> {
    const created = await service.createUpload(baseDto);
    await service.completeUpload(created.media.id, {});
    return created.media.id;
  }

  /** Drives a row into the terminal `failed` pipeline state, as a worker would. */
  async function markProcessingFailed(id: string): Promise<void> {
    await prisma.video.update({
      where: { id },
      data: {
        processingState: 'failed',
        processingStep: null,
        processingAttempts: MAX_ATTEMPTS,
        processingErrorCode: 'TRANSCODE_FAILED',
        processingErrorMessage: 'ffmpeg exited non-zero',
        processingStartedAt: new Date('2026-08-28T00:00:00.000Z'),
        processingCompletedAt: new Date('2026-08-28T00:05:00.000Z'),
      },
    });
  }

  describe('complete-upload hardening', () => {
    // A row WITH a recorded expectation keeps answering with the more
    // informative `UPLOAD_SIZE_MISMATCH` (it names expected vs. actual
    // bytes). Pinned here because the emptiness check added by this work
    // unit is deliberately ordered AFTER the size check precisely so this
    // long-standing behavior did not change — see `completeUpload`.
    it('still reports a zero-byte object as a size mismatch when an expectation was recorded', async () => {
      await buildService(true);
      const created = await service.createUpload(baseDto);
      const id = created.media.id;

      storageService.headObject.mockResolvedValue({
        key: buildSourceObjectKey(id),
        contentLength: 0,
        contentType: 'video/mp4',
      });

      await expect(service.completeUpload(id, {})).rejects.toMatchObject({
        code: AppErrorCode.UPLOAD_SIZE_MISMATCH,
      });

      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.lifecycleState).toBe('draft');
      expect(row.processingState).toBeNull();
      expect(queue.add).not.toHaveBeenCalled();
    });

    // THE hole this work unit closes: on a legacy row the size comparison is
    // skipped entirely, so before this check an empty object satisfied the
    // existence-only fallback and was promoted to `ready` and queued — only
    // for a worker to download zero bytes and fail much later.
    it('refuses a zero-byte object on a legacy row with no recorded expectation', async () => {
      await buildService(true);
      const created = await service.createUpload(baseDto);
      const id = created.media.id;

      await prisma.video.update({
        where: { id },
        data: { expectedSizeBytes: null, expectedContentType: null },
      });
      storageService.headObject.mockResolvedValue({
        key: buildSourceObjectKey(id),
        contentLength: 0,
        contentType: undefined,
      });

      await expect(service.completeUpload(id, {})).rejects.toMatchObject({
        code: AppErrorCode.UPLOAD_OBJECT_EMPTY,
      });

      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.lifecycleState).toBe('draft');
    });

    // PHASE 7 — "no overwrite of unrelated source". The key is always minted
    // server-side, so this state is unreachable through the API; the check
    // is the standing guarantee that it stays that way.
    it('refuses to finalize a row pointing at another media record source key', async () => {
      await buildService(true);
      const created = await service.createUpload(baseDto);
      const id = created.media.id;

      await prisma.video.update({
        where: { id },
        data: { objectStorageKey: buildSourceObjectKey('media-someone-else') },
      });

      await expect(service.completeUpload(id, {})).rejects.toMatchObject({
        code: AppErrorCode.MEDIA_SOURCE_KEY_MISMATCH,
      });

      // Refused BEFORE any storage call — the foreign object is never even
      // read, let alone written.
      expect(storageService.headObject).not.toHaveBeenCalled();
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.lifecycleState).toBe('draft');
    });

    it('still finalizes a well-formed upload, queueing exactly one job', async () => {
      await buildService(true);
      const id = await createCompletedMedia();

      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.lifecycleState).toBe('ready');
      expect(row.processingState).toBe('queued');
      expect(row.processingVersion).toBe(1);
      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    // A repeated completion is rejected by the editorial state machine
    // before any intent is recorded, so it can never double-enqueue.
    it('refuses a duplicate finalize and does not enqueue a second job', async () => {
      await buildService(true);
      const id = await createCompletedMedia();

      await expect(service.completeUpload(id, {})).rejects.toMatchObject({
        code: AppErrorCode.INVALID_MEDIA_LIFECYCLE_TRANSITION,
      });

      expect(queue.add).toHaveBeenCalledTimes(1);
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingVersion).toBe(1);
    });
  });

  describe('status contract', () => {
    it('reports awaiting_upload for a freshly created draft', async () => {
      await buildService(true);
      const created = await service.createUpload(baseDto);

      const status = await service.getStatus(created.media.id);

      expect(status.lifecycleState).toBe('draft');
      expect(status.processing.status).toBe('awaiting_upload');
      expect(status.processing.state).toBeNull();
      expect(status.processing.canRetry).toBe(false);
      expect(status.processing.hlsReady).toBe(false);
    });

    it('reports queued, with the deployment attempt cap, once the upload is finalized', async () => {
      await buildService(true);
      const id = await createCompletedMedia();

      const status = await service.getStatus(id);

      expect(status.processing.status).toBe('queued');
      expect(status.processing.state).toBe('queued');
      expect(status.processing.version).toBe(1);
      expect(status.processing.maxAttempts).toBe(MAX_ATTEMPTS);
    });

    it('reports running with the current step while a worker owns the row', async () => {
      await buildService(true);
      const id = await createCompletedMedia();
      await prisma.video.update({
        where: { id },
        data: {
          processingState: 'running',
          processingStep: 'packaging',
          processingAttempts: 1,
          processingStartedAt: new Date('2026-08-28T00:00:00.000Z'),
        },
      });

      const status = await service.getStatus(id);

      expect(status.processing.status).toBe('running');
      expect(status.processing.step).toBe('packaging');
      expect(status.processing.attempts).toBe(1);
      expect(status.processing.startedAt).toBe('2026-08-28T00:00:00.000Z');
    });

    // "transcode ready" — the promoted generation's renditions must reach the
    // dashboard so it can show what was actually produced.
    it('reports ready with the produced renditions after promotion', async () => {
      await buildService(true);
      const id = await createCompletedMedia();
      const renditions = [
        { name: '360p', width: 640, height: 360, bandwidth: 800_000 },
        { name: '720p', width: 1280, height: 720, bandwidth: 2_400_000 },
      ];
      await prisma.video.update({
        where: { id },
        data: {
          processingState: 'ready',
          processingStep: null,
          hlsMasterKey: `admin-media/${id}/hls/v1-a1-abc/master.m3u8`,
          hlsRenditions: renditions,
          transcodeProfileVersion: 'v1-a1',
          processingCompletedAt: new Date('2026-08-28T00:10:00.000Z'),
        },
      });

      const status = await service.getStatus(id);

      expect(status.processing.status).toBe('ready');
      expect(status.processing.hlsReady).toBe(true);
      expect(status.processing.renditions).toEqual(renditions);
      expect(status.processing.profileVersion).toBe('v1-a1');
      expect(status.processing.canRetry).toBe(false);
    });

    it('reports failed with the bounded error code, and marks the row retryable', async () => {
      await buildService(true);
      const id = await createCompletedMedia();
      await markProcessingFailed(id);

      const status = await service.getStatus(id);

      expect(status.processing.status).toBe('failed');
      expect(status.processing.errorCode).toBe('TRANSCODE_FAILED');
      expect(status.processing.canRetry).toBe(true);
    });

    // A status poll must never become a way to obtain upload/download
    // authorization, nor leak the bucket or endpoint the deployment uses.
    it('exposes no presigned URL, bucket, endpoint or credential', async () => {
      await buildService(true);
      const id = await createCompletedMedia();

      const serialized = JSON.stringify(await service.getStatus(id));

      expect(serialized).not.toMatch(/https?:\/\//);
      expect(serialized.toLowerCase()).not.toContain('secret');
      expect(serialized.toLowerCase()).not.toContain('accesskey');
      expect(serialized).not.toContain('X-Amz-Signature');
      // Only the initiate call ever mints a presigned URL.
      expect(storageService.createPresignedPutUrl).toHaveBeenCalledTimes(1);
    });

    it('reports uploaded — never queued — when transcoding is disabled', async () => {
      await buildService(false);
      const created = await service.createUpload(baseDto);
      await service.completeUpload(created.media.id, {});

      const status = await service.getStatus(created.media.id);

      expect(status.processing.status).toBe('uploaded');
      expect(status.processing.state).toBeNull();
      expect(status.processing.maxAttempts).toBeNull();
      expect(status.processing.canRetry).toBe(false);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('404s for an unknown media id', async () => {
      await buildService(true);

      await expect(service.getStatus('media-does-not-exist')).rejects.toThrow(
        AppException,
      );
    });
  });

  describe('retryTranscode', () => {
    // "retry with existing source" — the whole point: a failed transcode is
    // recoverable without re-uploading the bytes.
    it('re-queues a failed generation against the existing source, without a new upload', async () => {
      await buildService(true);
      const id = await createCompletedMedia();
      await markProcessingFailed(id);
      queue.add.mockClear();
      storageService.createPresignedPutUrl.mockClear();

      const result = await service.retryTranscode(id);

      expect(result.processing.status).toBe('queued');
      expect(result.processing.version).toBe(2);

      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingState).toBe('queued');
      expect(row.processingVersion).toBe(2);
      // A fresh generation inherits no error/progress detail from the failed one.
      expect(row.processingAttempts).toBe(0);
      expect(row.processingErrorCode).toBeNull();
      expect(row.processingErrorMessage).toBeNull();
      expect(row.processingStartedAt).toBeNull();
      expect(row.processingCompletedAt).toBeNull();
      // The source key is untouched, and no new upload authorization is issued.
      expect(row.objectStorageKey).toBe(buildSourceObjectKey(id));
      expect(storageService.createPresignedPutUrl).not.toHaveBeenCalled();
      // Exactly one new job, for the NEW generation.
      expect(queue.add).toHaveBeenCalledTimes(1);
      const [jobId] = queue.add.mock.calls[0] as [string, unknown];
      expect(jobId).toBe(buildTranscodeJobId(id, 2));
    });

    // "double enqueue" — a double-clicked retry must not create two
    // generations. The second call loses the compare-and-swap.
    it('enqueues exactly once when the same retry is issued twice', async () => {
      await buildService(true);
      const id = await createCompletedMedia();
      await markProcessingFailed(id);
      queue.add.mockClear();

      await service.retryTranscode(id);
      await expect(service.retryTranscode(id)).rejects.toMatchObject({
        code: AppErrorCode.MEDIA_TRANSCODE_NOT_RETRYABLE,
      });

      expect(queue.add).toHaveBeenCalledTimes(1);
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingVersion).toBe(2);
    });

    it('enqueues exactly once for two concurrent retries of the same row', async () => {
      await buildService(true);
      const id = await createCompletedMedia();
      await markProcessingFailed(id);
      queue.add.mockClear();

      const outcomes = await Promise.allSettled([
        service.retryTranscode(id),
        service.retryTranscode(id),
      ]);

      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(queue.add).toHaveBeenCalledTimes(1);
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingVersion).toBe(2);
    });

    it.each([['queued'], ['running'], ['ready']])(
      'refuses a row whose current processing state is %s',
      async (processingState) => {
        await buildService(true);
        const id = await createCompletedMedia();
        await prisma.video.update({
          where: { id },
          data: { processingState },
        });
        queue.add.mockClear();

        await expect(service.retryTranscode(id)).rejects.toMatchObject({
          code: AppErrorCode.MEDIA_TRANSCODE_NOT_RETRYABLE,
        });
        expect(queue.add).not.toHaveBeenCalled();
      },
    );

    it('refuses a draft row whose upload was never finalized', async () => {
      await buildService(true);
      const created = await service.createUpload(baseDto);

      await expect(
        service.retryTranscode(created.media.id),
      ).rejects.toMatchObject({
        code: AppErrorCode.MEDIA_TRANSCODE_NOT_RETRYABLE,
      });
      expect(queue.add).not.toHaveBeenCalled();
    });

    // Retrying would enqueue work a worker can only fail on with
    // SOURCE_MISSING minutes later. Better to say so now, and leave the row
    // in `failed` so a fresh upload stays the available path.
    it('refuses when the source object has since disappeared from storage', async () => {
      await buildService(true);
      const id = await createCompletedMedia();
      await markProcessingFailed(id);
      queue.add.mockClear();
      storageService.headObject.mockResolvedValue(null);

      await expect(service.retryTranscode(id)).rejects.toMatchObject({
        code: AppErrorCode.MEDIA_FILE_NOT_FOUND,
      });

      expect(queue.add).not.toHaveBeenCalled();
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingState).toBe('failed');
      expect(row.processingVersion).toBe(1);
    });

    it('refuses when the stored source object is empty', async () => {
      await buildService(true);
      const id = await createCompletedMedia();
      await markProcessingFailed(id);
      queue.add.mockClear();
      storageService.headObject.mockResolvedValue({
        key: buildSourceObjectKey(id),
        contentLength: 0,
        contentType: 'video/mp4',
      });

      await expect(service.retryTranscode(id)).rejects.toMatchObject({
        code: AppErrorCode.UPLOAD_OBJECT_EMPTY,
      });
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('refuses to retry against another media record source key', async () => {
      await buildService(true);
      const id = await createCompletedMedia();
      await markProcessingFailed(id);
      queue.add.mockClear();
      storageService.headObject.mockClear();
      await prisma.video.update({
        where: { id },
        data: { objectStorageKey: buildSourceObjectKey('media-someone-else') },
      });

      await expect(service.retryTranscode(id)).rejects.toMatchObject({
        code: AppErrorCode.MEDIA_SOURCE_KEY_MISMATCH,
      });

      expect(storageService.headObject).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('refuses when transcoding is disabled on this deployment', async () => {
      await buildService(false);
      const created = await service.createUpload(baseDto);
      await service.completeUpload(created.media.id, {});
      await markProcessingFailed(created.media.id);

      await expect(
        service.retryTranscode(created.media.id),
      ).rejects.toMatchObject({
        code: AppErrorCode.MEDIA_TRANSCODE_NOT_ENABLED,
      });
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('404s for an unknown media id', async () => {
      await buildService(true);

      await expect(
        service.retryTranscode('media-does-not-exist'),
      ).rejects.toThrow(AppException);
    });

    // The durable `queued` intent has already committed, so a dead queue
    // must not fail the operator's retry — the reconciler re-enqueues later.
    it('keeps the retry successful when the enqueue itself fails', async () => {
      await buildService(true);
      const id = await createCompletedMedia();
      await markProcessingFailed(id);
      queue.add.mockClear();
      queue.add.mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:6379'));

      await expect(service.retryTranscode(id)).resolves.toMatchObject({
        processing: { status: 'queued', version: 2 },
      });

      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingState).toBe('queued');
      expect(row.processingVersion).toBe(2);
    });
  });
});
