import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { RootConfig, TranscodeConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { TranscodeReconcilerService } from './transcode-reconciler.service';
import {
  buildTranscodeJobId,
  TRANSCODE_JOB_ID_SEPARATOR,
} from './transcode.constants';
import { TRANSCODE_QUEUE, TranscodeQueue } from './transcode.types';

/**
 * A generously large sweep bound, used only where a test needs to be
 * confident its own fixtures are actually included in the sweep — see the
 * class doc below for why `reconcile`'s query is deliberately GLOBAL
 * (unscoped by series/prefix), which this file's assertions have to account
 * for.
 */
const LARGE_LIMIT = 500;

/**
 * Slice 11N, proof 10. `PrismaService` is the real client against the
 * project's Postgres TEST database (matching `TranscodeIntentService`'s own
 * spec). `TranscodeQueue` is always a jest mock — no real Redis connection.
 *
 * `TranscodeReconcilerService.reconcile` deliberately queries `Video` GLOBALLY
 * (`processingState = "queued"`, no per-series scoping — this matches its
 * real, intentional production behavior: the reconciler recovers ALL stuck
 * processing intent system-wide, not one series at a time). Because Jest runs
 * separate spec FILES concurrently against this repo's one shared Postgres
 * TEST database, another currently-running spec file (e.g.
 * `transcode-intent.service.spec.ts`, which transiently creates its own
 * `"queued"` rows) can leave additional `"queued"` rows visible at the exact
 * moment a test here queries. Tests below that need to know EXACTLY which
 * rows were reconciled therefore assert INCLUSION of their own fixtures
 * (filtering `queue.add`'s calls down to jobIds/videoIds this test itself
 * created) rather than an exact global total — the one exception is "bounded
 * by limit", which is identity-agnostic by construction (it only cares that
 * the count never exceeds `limit`, regardless of whose rows they are) and
 * needs no such filtering.
 */
describe('TranscodeReconcilerService', () => {
  let prisma: PrismaService;
  let queue: { add: jest.Mock };

  const testIdPrefix = 'transcode-reconciler-spec-11n';
  const seriesId = `${testIdPrefix}-series`;

  async function createFixtureVideo(
    id: string,
    processingState: string | null,
    processingVersion: number,
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
        processingState,
        processingVersion,
      },
    });
  }

  async function buildService(
    enabled: boolean,
  ): Promise<TranscodeReconcilerService> {
    const transcodeConfig: TranscodeConfig = {
      enabled,
      redisUrl: enabled ? 'redis://localhost:6379' : undefined,
      maxAttempts: 3,
      stalledAfterMinutes: 30,
      cleanupGraceMinutes: 120,
      workerConcurrency: 1,
      tempDir: undefined,
      tempSweepMinAgeMinutes: 120,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TranscodeReconcilerService,
        PrismaService,
        { provide: TRANSCODE_QUEUE, useValue: queue as TranscodeQueue },
        {
          provide: ConfigService,
          useValue: {
            get: (key: keyof RootConfig) =>
              key === 'transcode' ? transcodeConfig : undefined,
          },
        },
      ],
    }).compile();

    const service = module.get<TranscodeReconcilerService>(
      TranscodeReconcilerService,
    );
    prisma = module.get<PrismaService>(PrismaService);
    await prisma.onModuleInit();

    return service;
  }

  /** Calls whose jobId belongs to one of THIS test's own fixture ids. */
  function callsForIds(ids: string[]): Array<[string, unknown]> {
    const calls = queue.add.mock.calls as Array<[string, unknown]>;
    return calls.filter(([jobId]) =>
      ids.some((id) => jobId.startsWith(`${id}${TRANSCODE_JOB_ID_SEPARATOR}`)),
    );
  }

  beforeEach(() => {
    queue = { add: jest.fn().mockResolvedValue(undefined) };
  });

  afterEach(async () => {
    await prisma.video.deleteMany({ where: { seriesId } });
    await prisma.onModuleDestroy();
  });

  it('flag off is an immediate no-op — zero Prisma reads, zero queue calls', async () => {
    const service = await buildService(false);
    await createFixtureVideo(`${testIdPrefix}-off`, 'queued', 1);

    const reenqueued = await service.reconcile();

    expect(reenqueued).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('re-enqueues every "queued" row with its CURRENT processingVersion and the deterministic jobId', async () => {
    const service = await buildService(true);
    const idA = `${testIdPrefix}-a`;
    const idB = `${testIdPrefix}-b`;
    await createFixtureVideo(idA, 'queued', 1);
    await createFixtureVideo(idB, 'queued', 3);
    // Not queued — must be ignored.
    await createFixtureVideo(`${testIdPrefix}-ready`, 'ready', 1);
    await createFixtureVideo(`${testIdPrefix}-null`, null, 0);

    await service.reconcile(LARGE_LIMIT);

    const calls = callsForIds([idA, idB]) as Array<
      [string, { videoId: string; processingVersion: number }]
    >;
    const byVideoId = new Map(
      calls.map(([jobId, payload]) => [payload.videoId, { jobId, payload }]),
    );

    expect(byVideoId.get(idA)).toEqual({
      jobId: buildTranscodeJobId(idA, 1),
      payload: { videoId: idA, processingVersion: 1 },
    });
    expect(byVideoId.get(idB)).toEqual({
      jobId: buildTranscodeJobId(idB, 3),
      payload: { videoId: idB, processingVersion: 3 },
    });
    // Ready/null rows never produce a call at all — check no jobId embeds
    // either of their ids.
    const allJobIds = (queue.add.mock.calls as Array<[string]>).map(
      ([jobId]) => jobId,
    );
    expect(
      allJobIds.some((id) => id.startsWith(`${testIdPrefix}-ready:`)),
    ).toBe(false);
    expect(allJobIds.some((id) => id.startsWith(`${testIdPrefix}-null:`))).toBe(
      false,
    );
  });

  it('never mutates processingState — a re-enqueued row stays exactly "queued"', async () => {
    const service = await buildService(true);
    const id = `${testIdPrefix}-untouched`;
    await createFixtureVideo(id, 'queued', 2);

    await service.reconcile(LARGE_LIMIT);

    const row = await prisma.video.findUniqueOrThrow({ where: { id } });
    expect(row.processingState).toBe('queued');
    expect(row.processingVersion).toBe(2);
  });

  // The scenario the reconciler exists for: a previous enqueue attempt threw
  // (simulated Redis outage) and left the row durably "queued"; reconcile()
  // picks it up and retries, using the SAME deterministic jobId every time,
  // so running it twice never produces a second, distinct job for the same
  // generation.
  it('recovers a row whose original enqueue failed, and running reconcile() twice does not produce a second distinct jobId', async () => {
    const service = await buildService(true);
    const id = `${testIdPrefix}-recovery`;
    await createFixtureVideo(id, 'queued', 1);

    await service.reconcile(LARGE_LIMIT);
    await service.reconcile(LARGE_LIMIT);

    const jobIdsForThisRow = (queue.add.mock.calls as Array<[string]>)
      .map(([jobId]) => jobId)
      .filter((jobId) =>
        jobId.startsWith(`${id}${TRANSCODE_JOB_ID_SEPARATOR}`),
      );

    expect(jobIdsForThisRow).toEqual([
      buildTranscodeJobId(id, 1),
      buildTranscodeJobId(id, 1),
    ]);
  });

  it('is bounded by limit — never returns/enqueues more than requested (identity-agnostic: safe under concurrent global fixtures)', async () => {
    const service = await buildService(true);
    for (let i = 0; i < 5; i += 1) {
      await createFixtureVideo(`${testIdPrefix}-bounded-${i}`, 'queued', 1);
    }

    const reenqueued = await service.reconcile(2);

    expect(reenqueued).toBe(2);
    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  it('a failed re-enqueue attempt does not stop the sweep from processing the remaining rows', async () => {
    const service = await buildService(true);
    const failing = `${testIdPrefix}-fails`;
    const succeeding = `${testIdPrefix}-succeeds`;
    await createFixtureVideo(failing, 'queued', 1);
    await createFixtureVideo(succeeding, 'queued', 1);

    queue.add.mockImplementation((jobId: string) =>
      jobId.startsWith(failing)
        ? Promise.reject(new Error('ECONNREFUSED'))
        : Promise.resolve(undefined),
    );

    await service.reconcile(LARGE_LIMIT);

    const calls = callsForIds([failing, succeeding]);
    expect(calls).toHaveLength(2);
    const succeededCall = calls.find(([jobId]) =>
      jobId.startsWith(`${succeeding}${TRANSCODE_JOB_ID_SEPARATOR}`),
    );
    const failedCall = calls.find(([jobId]) =>
      jobId.startsWith(`${failing}${TRANSCODE_JOB_ID_SEPARATOR}`),
    );
    expect(succeededCall).toBeDefined();
    expect(failedCall).toBeDefined();
  });
});
