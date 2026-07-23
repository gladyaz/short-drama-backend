import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from './analytics.service';
import { MAX_PROPERTY_STRING_LENGTH } from './analytics.types';

/**
 * Integration-style spec (Phase 11, work unit 11-B6), following the
 * `InteractionsService`/`EntitlementsService` precedent: real
 * `PrismaService` against the project's Postgres database, self-cleaning
 * via `afterEach`.
 */
describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let prisma: PrismaService;

  const testIdPrefix = 'analytics-service-spec';
  let userId: string;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AnalyticsService, PrismaService],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
    prisma = module.get<PrismaService>(PrismaService);
    await prisma.onModuleInit();

    const user = await prisma.user.create({
      data: {
        email: `${testIdPrefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
        passwordHash: 'irrelevant-for-this-spec',
      },
    });
    userId = user.id;
  });

  afterEach(async () => {
    // Everything this spec writes is attached to its own per-run user; the
    // SET NULL test deletes its orphaned row itself before this runs.
    await prisma.analyticsEvent.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({
      where: { email: { contains: testIdPrefix } },
    });
    await prisma.onModuleDestroy();
  });

  it('persists a batch and reports the accepted count', async () => {
    const result = await service.ingest(userId, [
      {
        eventName: 'feed_view',
        clientTimestamp: new Date().toISOString(),
        platform: 'ios',
      },
      {
        eventName: 'video_play',
        properties: {
          videoId: 'video-104-01',
          seriesId: 'series-104',
          episodeNumber: 1,
        },
        clientTimestamp: new Date().toISOString(),
        platform: 'ios',
      },
    ]);

    expect(result).toEqual({ accepted: 2 });

    const rows = await prisma.analyticsEvent.findMany({ where: { userId } });
    expect(rows).toHaveLength(2);
    const playRow = rows.find((row) => row.eventName === 'video_play');
    expect(playRow?.properties).toEqual({
      videoId: 'video-104-01',
      seriesId: 'series-104',
      episodeNumber: 1,
    });
  });

  it('strips property keys outside the allowlist and non-scalar values', async () => {
    await service.ingest(userId, [
      {
        eventName: 'video_like',
        properties: {
          videoId: 'video-104-01',
          value: true,
          email: 'leak@example.test',
          nested: { deep: 'object' },
          list: [1, 2, 3],
        },
        clientTimestamp: new Date().toISOString(),
        platform: 'android',
      },
    ]);

    const row = await prisma.analyticsEvent.findFirstOrThrow({
      where: { userId, eventName: 'video_like' },
    });

    expect(row.properties).toEqual({ videoId: 'video-104-01', value: true });
  });

  it('truncates oversized string properties', async () => {
    await service.ingest(userId, [
      {
        eventName: 'app_error',
        properties: { message: 'x'.repeat(MAX_PROPERTY_STRING_LENGTH + 500) },
        clientTimestamp: new Date().toISOString(),
        platform: 'web',
      },
    ]);

    const row = await prisma.analyticsEvent.findFirstOrThrow({
      where: { userId, eventName: 'app_error' },
    });

    expect((row.properties as { message: string }).message).toHaveLength(
      MAX_PROPERTY_STRING_LENGTH,
    );
  });

  it('rejects a calendar-invalid but ISO8601-shaped timestamp with a 400, not a raw DB error', async () => {
    // "2026-W01" passes class-validator's shape-based @IsISO8601() but is
    // not parseable by new Date() — review finding, fix cycle 1.
    await expect(
      service.ingest(userId, [
        {
          eventName: 'feed_view',
          clientTimestamp: '2026-W01',
          platform: 'ios',
        },
      ]),
    ).rejects.toMatchObject({ status: 400 });

    expect(await prisma.analyticsEvent.count({ where: { userId } })).toBe(0);
  });

  it('sets userId to null (keeping the event) when the user is deleted', async () => {
    await service.ingest(userId, [
      {
        eventName: 'feed_view',
        clientTimestamp: new Date().toISOString(),
        platform: 'ios',
      },
    ]);
    const before = await prisma.analyticsEvent.findFirstOrThrow({
      where: { userId },
    });

    await prisma.user.delete({ where: { id: userId } });

    const after = await prisma.analyticsEvent.findUniqueOrThrow({
      where: { id: before.id },
    });
    expect(after.userId).toBeNull();

    await prisma.analyticsEvent.delete({ where: { id: after.id } });
  });
});
