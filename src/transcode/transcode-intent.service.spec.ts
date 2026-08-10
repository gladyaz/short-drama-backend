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
});
