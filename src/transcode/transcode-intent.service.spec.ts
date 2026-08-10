import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { TranscodeIntentService } from './transcode-intent.service';
import { TRANSCODE_QUEUE, TranscodeQueue } from './transcode.types';

/**
 * Slice 11N. `PrismaService` is the real client against the project's
 * Postgres TEST database (matching `AdminMediaService`'s own
 * `admin-media.service.spec.ts` precedent), self-cleaning via `afterEach`.
 * `TranscodeQueue` is ALWAYS a jest mock here — this file never constructs
 * `BullmqTranscodeQueueClient` and never opens a real Redis connection.
 */
describe('TranscodeIntentService', () => {
  let service: TranscodeIntentService;
  let prisma: PrismaService;
  let queue: { add: jest.Mock };

  const testIdPrefix = 'transcode-intent-spec-11n';

  async function createFixtureVideo(
    id: string,
    overrides: Partial<{
      processingState: string | null;
      processingVersion: number;
    }> = {},
  ): Promise<void> {
    await prisma.video.create({
      data: {
        id,
        seriesId: `${testIdPrefix}-series`,
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
      },
    });
  }

  beforeEach(async () => {
    queue = { add: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TranscodeIntentService,
        PrismaService,
        { provide: TRANSCODE_QUEUE, useValue: queue as TranscodeQueue },
      ],
    }).compile();

    service = module.get<TranscodeIntentService>(TranscodeIntentService);
    prisma = module.get<PrismaService>(PrismaService);
    await prisma.onModuleInit();
  });

  afterEach(async () => {
    await prisma.video.deleteMany({
      where: { seriesId: `${testIdPrefix}-series` },
    });
    await prisma.onModuleDestroy();
  });

  describe('requestProcessing', () => {
    it('atomically sets processingState to "queued" and increments processingVersion from 0 to 1', async () => {
      const id = `${testIdPrefix}-basic`;
      await createFixtureVideo(id);

      const version = await service.requestProcessing(id);

      expect(version).toBe(1);
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingState).toBe('queued');
      expect(row.processingVersion).toBe(1);
    });

    it('enqueues with the deterministic jobId "<videoId>:<processingVersion>" and a payload of ONLY videoId + processingVersion (proof 7)', async () => {
      const id = `${testIdPrefix}-payload`;
      await createFixtureVideo(id);

      await service.requestProcessing(id);

      expect(queue.add).toHaveBeenCalledTimes(1);
      const [jobId, payload] = queue.add.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(jobId).toBe(`${id}:1`);
      expect(Object.keys(payload).sort()).toEqual([
        'processingVersion',
        'videoId',
      ]);
      expect(payload).toEqual({ videoId: id, processingVersion: 1 });
    });

    // Proof 8 (duplicate suppression / concurrent-increment safety): two
    // requestProcessing calls against the SAME row produce two DISTINCT,
    // consecutive versions (1 then 2) — never the same value twice — and
    // therefore two DISTINCT jobIds, which is what makes BullMQ's own jobId
    // dedupe meaningful rather than accidentally deduping two real,
    // different processing requests.
    it('sequential calls produce distinct, consecutive versions (1, then 2) and distinct jobIds', async () => {
      const id = `${testIdPrefix}-sequential`;
      await createFixtureVideo(id);

      const first = await service.requestProcessing(id);
      const second = await service.requestProcessing(id);

      expect(first).toBe(1);
      expect(second).toBe(2);
      expect(queue.add).toHaveBeenCalledTimes(2);
      const firstJobId = (queue.add.mock.calls[0] as [string])[0];
      const secondJobId = (queue.add.mock.calls[1] as [string])[0];
      expect(firstJobId).toBe(`${id}:1`);
      expect(secondJobId).toBe(`${id}:2`);
      expect(firstJobId).not.toBe(secondJobId);

      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingVersion).toBe(2);
    });

    // Proof 8, concurrent case: the atomic `{ increment: 1 }` update is what
    // guarantees this — a naive read-then-write would risk both calls
    // reading version 0 and both writing version 1.
    it('CONCURRENT (parallel) calls against the same row still land on two distinct versions, {1, 2}', async () => {
      const id = `${testIdPrefix}-concurrent`;
      await createFixtureVideo(id);

      const [versionA, versionB] = await Promise.all([
        service.requestProcessing(id),
        service.requestProcessing(id),
      ]);

      expect(new Set([versionA, versionB])).toEqual(new Set([1, 2]));

      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingVersion).toBe(2);
    });

    it('never throws when the queue enqueue fails, and leaves the row durably "queued" (Redis-loss tolerance)', async () => {
      const id = `${testIdPrefix}-enqueue-fails`;
      await createFixtureVideo(id);
      queue.add.mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:6379'));

      await expect(service.requestProcessing(id)).resolves.toBe(1);

      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingState).toBe('queued');
      expect(row.processingVersion).toBe(1);
    });
  });

  describe('transitionIfVersion (CAS)', () => {
    it('applies the transition and returns count 1 when the expected version matches', async () => {
      const id = `${testIdPrefix}-cas-match`;
      await createFixtureVideo(id, {
        processingState: 'queued',
        processingVersion: 1,
      });

      const affected = await service.transitionIfVersion(id, 1, 'running');

      expect(affected).toBe(1);
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingState).toBe('running');
    });

    // Proof 9: a stale version must affect ZERO rows and leave the current
    // state completely intact.
    it('a stale (mismatched) expected version affects ZERO rows and leaves processingState untouched', async () => {
      const id = `${testIdPrefix}-cas-stale`;
      await createFixtureVideo(id, {
        processingState: 'queued',
        processingVersion: 2,
      });

      const affected = await service.transitionIfVersion(id, 1, 'running');

      expect(affected).toBe(0);
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingState).toBe('queued');
      expect(row.processingVersion).toBe(2);
    });

    it('a non-existent row affects zero rows without throwing', async () => {
      const affected = await service.transitionIfVersion(
        `${testIdPrefix}-does-not-exist`,
        0,
        'running',
      );

      expect(affected).toBe(0);
    });
  });

  // Slice 11P — the worker-facing CAS methods.
  describe('claimRunning', () => {
    it('claims queued -> running, setting processingStartedAt/processingStep/processingAttempts', async () => {
      const id = `${testIdPrefix}-claim-ok`;
      await createFixtureVideo(id, {
        processingState: 'queued',
        processingVersion: 1,
      });

      const affected = await service.claimRunning(id, 1);

      expect(affected).toBe(1);
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingState).toBe('running');
      expect(row.processingStep).toBe('probing');
      expect(row.processingAttempts).toBe(1);
      expect(row.processingStartedAt).not.toBeNull();
    });

    it('a second concurrent claim attempt affects zero rows (only one worker can win)', async () => {
      const id = `${testIdPrefix}-claim-race`;
      await createFixtureVideo(id, {
        processingState: 'queued',
        processingVersion: 1,
      });

      const first = await service.claimRunning(id, 1);
      const second = await service.claimRunning(id, 1);

      expect(first).toBe(1);
      expect(second).toBe(0);
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingAttempts).toBe(1); // not double-incremented
    });

    it('a stale expected version affects zero rows and leaves the row queued', async () => {
      const id = `${testIdPrefix}-claim-stale`;
      await createFixtureVideo(id, {
        processingState: 'queued',
        processingVersion: 2,
      });

      const affected = await service.claimRunning(id, 1);

      expect(affected).toBe(0);
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingState).toBe('queued');
    });

    it('refuses to claim a row that is not currently "queued" (e.g. already running)', async () => {
      const id = `${testIdPrefix}-claim-not-queued`;
      await createFixtureVideo(id, {
        processingState: 'running',
        processingVersion: 1,
      });

      const affected = await service.claimRunning(id, 1);

      expect(affected).toBe(0);
    });
  });

  describe('updateStep', () => {
    it('updates processingStep for the current running generation', async () => {
      const id = `${testIdPrefix}-step-ok`;
      await createFixtureVideo(id, {
        processingState: 'running',
        processingVersion: 1,
      });

      const affected = await service.updateStep(id, 1, '360p');

      expect(affected).toBe(1);
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingStep).toBe('360p');
    });

    it('affects zero rows for a stale version (superseded mid-run)', async () => {
      const id = `${testIdPrefix}-step-stale`;
      await createFixtureVideo(id, {
        processingState: 'running',
        processingVersion: 2,
      });

      const affected = await service.updateStep(id, 1, '360p');

      expect(affected).toBe(0);
    });

    it('affects zero rows when the row is not currently "running"', async () => {
      const id = `${testIdPrefix}-step-not-running`;
      await createFixtureVideo(id, {
        processingState: 'queued',
        processingVersion: 1,
      });

      const affected = await service.updateStep(id, 1, '360p');

      expect(affected).toBe(0);
    });
  });

  describe('promoteIfCurrent', () => {
    const promotion = {
      hlsMasterKey: 'admin-media/x/hls/v1-a1-uuid/master.m3u8',
      hlsRenditions: [
        { name: '360p', width: 360, height: 640, bandwidth: 1_000_000 },
      ],
      transcodeProfileVersion: 'ladder-v1',
    };

    it('promotes a running row at the expected version to ready, setting hlsMasterKey/hlsRenditions/profileVersion', async () => {
      const id = `${testIdPrefix}-promote-ok`;
      await createFixtureVideo(id, {
        processingState: 'running',
        processingVersion: 1,
      });

      const affected = await service.promoteIfCurrent(id, 1, promotion);

      expect(affected).toBe(1);
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingState).toBe('ready');
      expect(row.processingStep).toBeNull();
      expect(row.hlsMasterKey).toBe(promotion.hlsMasterKey);
      expect(row.hlsRenditions).toEqual(promotion.hlsRenditions);
      expect(row.transcodeProfileVersion).toBe('ladder-v1');
      expect(row.processingCompletedAt).not.toBeNull();
    });

    // Proof 4: a stale version must never flip the live output.
    it('a stale expected version affects zero rows and leaves hlsMasterKey untouched', async () => {
      const id = `${testIdPrefix}-promote-stale`;
      await createFixtureVideo(id, {
        processingState: 'running',
        processingVersion: 2,
      });
      await prisma.video.update({
        where: { id },
        data: { hlsMasterKey: 'admin-media/x/hls/v1-old/master.m3u8' },
      });

      const affected = await service.promoteIfCurrent(id, 1, promotion);

      expect(affected).toBe(0);
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.hlsMasterKey).toBe('admin-media/x/hls/v1-old/master.m3u8');
      expect(row.processingState).toBe('running');
    });

    it('refuses to promote a row that is not currently "running"', async () => {
      const id = `${testIdPrefix}-promote-not-running`;
      await createFixtureVideo(id, {
        processingState: 'queued',
        processingVersion: 1,
      });

      const affected = await service.promoteIfCurrent(id, 1, promotion);

      expect(affected).toBe(0);
    });
  });

  describe('failWithError', () => {
    it('fails a running row at the expected version, recording the error code/message', async () => {
      const id = `${testIdPrefix}-fail-ok`;
      await createFixtureVideo(id, {
        processingState: 'running',
        processingVersion: 1,
      });

      const affected = await service.failWithError(
        id,
        1,
        'TRANSCODE_FAILED',
        'ffmpeg exited with a non-zero status for rung "360p"',
      );

      expect(affected).toBe(1);
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingState).toBe('failed');
      expect(row.processingStep).toBeNull();
      expect(row.processingErrorCode).toBe('TRANSCODE_FAILED');
      expect(row.processingErrorMessage).toBe(
        'ffmpeg exited with a non-zero status for rung "360p"',
      );
      expect(row.processingCompletedAt).not.toBeNull();
    });

    it('a stale expected version affects zero rows', async () => {
      const id = `${testIdPrefix}-fail-stale`;
      await createFixtureVideo(id, {
        processingState: 'running',
        processingVersion: 2,
      });

      const affected = await service.failWithError(
        id,
        1,
        'TRANSCODE_FAILED',
        'stale attempt',
      );

      expect(affected).toBe(0);
    });
  });

  describe('recordSourceProbe', () => {
    it('persists probed source metadata for a running row at the expected version', async () => {
      const id = `${testIdPrefix}-probe-ok`;
      await createFixtureVideo(id, {
        processingState: 'running',
        processingVersion: 1,
      });

      const affected = await service.recordSourceProbe(id, 1, {
        width: 1080,
        height: 1920,
        durationSeconds: 12.4,
        fps: 29.97,
      });

      expect(affected).toBe(1);
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.sourceWidth).toBe(1080);
      expect(row.sourceHeight).toBe(1920);
      expect(row.sourceDurationSeconds).toBe(12);
      expect(row.sourceFps).toBeCloseTo(29.97);
    });
  });

  describe('recordIntent (Slice 11P: transactional intent primitive)', () => {
    it('behaves identically to the write half of requestProcessing when called standalone', async () => {
      const id = `${testIdPrefix}-record-intent-standalone`;
      await createFixtureVideo(id);

      const version = await service.recordIntent(prisma, id);

      expect(version).toBe(1);
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingState).toBe('queued');
      expect(row.processingVersion).toBe(1);
    });

    it('runs inside a caller-owned $transaction and is rolled back if the transaction later throws', async () => {
      const id = `${testIdPrefix}-record-intent-rollback`;
      await createFixtureVideo(id);

      await expect(
        prisma.$transaction(async (tx) => {
          await service.recordIntent(tx, id);
          throw new Error('simulated failure after the intent write');
        }),
      ).rejects.toThrow('simulated failure after the intent write');

      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      // Rolled back — the transaction never committed.
      expect(row.processingState).toBeNull();
      expect(row.processingVersion).toBe(0);
    });

    it('resets processingStep/processingAttempts/error fields to their fresh-generation values', async () => {
      const id = `${testIdPrefix}-record-intent-reset`;
      await createFixtureVideo(id);
      await prisma.video.update({
        where: { id },
        data: {
          processingState: 'failed',
          processingVersion: 1,
          processingStep: null,
          processingAttempts: 3,
          processingErrorCode: 'TRANSCODE_FAILED',
          processingErrorMessage: 'previous generation failure',
        },
      });

      const version = await service.recordIntent(prisma, id);

      expect(version).toBe(2);
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.processingState).toBe('queued');
      expect(row.processingStep).toBeNull();
      expect(row.processingAttempts).toBe(0);
      expect(row.processingErrorCode).toBeNull();
      expect(row.processingErrorMessage).toBeNull();
    });
  });

  describe('enqueueBestEffort', () => {
    it('enqueues with the deterministic jobId and never throws on a queue failure', async () => {
      const id = `${testIdPrefix}-enqueue-best-effort`;
      queue.add.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(service.enqueueBestEffort(id, 3)).resolves.toBeUndefined();

      expect(queue.add).toHaveBeenCalledWith(`${id}:3`, {
        videoId: id,
        processingVersion: 3,
      });
    });
  });
});
