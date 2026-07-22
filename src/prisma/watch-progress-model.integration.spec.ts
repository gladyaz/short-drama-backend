import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from './prisma.service';

/**
 * Integration-style spec confirming the `WatchProgress` model (added in
 * Phase 9, work unit 9-B1) can be created and linked to a `User` via
 * `PrismaService`, that the unique `(userId, seriesId)` constraint is
 * enforced (exactly one progress row per user-per-series, matching mobile's
 * local `Record<seriesId, SeriesProgress>` shape), and that deleting a
 * `User` cascades to delete their progress rows. Uses the project's dev
 * SQLite database (same one `PrismaService` connects to elsewhere in the
 * test suite) but is fully self-cleaning: every row it creates is deleted in
 * `afterEach`.
 */
describe('WatchProgress model (Prisma integration)', () => {
  let service: PrismaService;
  const testEmail = 'watch-progress-spec+9b1@example.test';
  const otherEmail = 'watch-progress-spec-other+9b1@example.test';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();

    service = module.get<PrismaService>(PrismaService);
    await service.onModuleInit();
  });

  afterEach(async () => {
    await service.watchProgress.deleteMany({
      where: { user: { email: { in: [testEmail, otherEmail] } } },
    });
    await service.user.deleteMany({
      where: { email: { in: [testEmail, otherEmail] } },
    });
    await service.onModuleDestroy();
  });

  it('creates a watch progress row linked to a user', async () => {
    const user = await service.user.create({
      data: {
        email: testEmail,
        passwordHash: 'hashed-value-not-a-real-secret',
      },
    });

    const progress = await service.watchProgress.create({
      data: {
        userId: user.id,
        seriesId: 'series-104',
        lastWatchedVideoId: 'video-104-01',
        lastWatchedEpisodeNumber: 1,
        positionSeconds: 42,
        durationSeconds: 120,
      },
    });

    expect(progress.id).toEqual(expect.any(String));
    expect(progress.userId).toBe(user.id);
    expect(progress.seriesId).toBe('series-104');
    expect(progress.lastWatchedVideoId).toBe('video-104-01');
    expect(progress.lastWatchedEpisodeNumber).toBe(1);
    expect(progress.positionSeconds).toBe(42);
    expect(progress.durationSeconds).toBe(120);
    expect(progress.updatedAt).toBeInstanceOf(Date);

    const found = await service.watchProgress.findUnique({
      where: { id: progress.id },
    });

    expect(found).not.toBeNull();
    expect(found?.seriesId).toBe('series-104');
  });

  it('allows durationSeconds to be omitted', async () => {
    const user = await service.user.create({
      data: {
        email: testEmail,
        passwordHash: 'hashed-value-not-a-real-secret',
      },
    });

    const progress = await service.watchProgress.create({
      data: {
        userId: user.id,
        seriesId: 'series-104',
        lastWatchedVideoId: 'video-104-01',
        lastWatchedEpisodeNumber: 1,
        positionSeconds: 0,
      },
    });

    expect(progress.durationSeconds).toBeNull();
  });

  it('enforces uniqueness on (userId, seriesId)', async () => {
    const user = await service.user.create({
      data: {
        email: testEmail,
        passwordHash: 'hashed-value-not-a-real-secret',
      },
    });

    await service.watchProgress.create({
      data: {
        userId: user.id,
        seriesId: 'series-104',
        lastWatchedVideoId: 'video-104-01',
        lastWatchedEpisodeNumber: 1,
        positionSeconds: 10,
      },
    });

    await expect(
      service.watchProgress.create({
        data: {
          userId: user.id,
          seriesId: 'series-104',
          lastWatchedVideoId: 'video-104-02',
          lastWatchedEpisodeNumber: 2,
          positionSeconds: 20,
        },
      }),
    ).rejects.toThrow();

    // A different user progressing through the same series is not blocked
    // by the constraint (it is scoped per-user, not global).
    const otherUser = await service.user.create({
      data: {
        email: otherEmail,
        passwordHash: 'hashed-value-not-a-real-secret',
      },
    });

    await expect(
      service.watchProgress.create({
        data: {
          userId: otherUser.id,
          seriesId: 'series-104',
          lastWatchedVideoId: 'video-104-01',
          lastWatchedEpisodeNumber: 1,
          positionSeconds: 5,
        },
      }),
    ).resolves.toBeDefined();
  });

  it('cascade deletes progress rows when their user is deleted', async () => {
    const user = await service.user.create({
      data: {
        email: testEmail,
        passwordHash: 'hashed-value-not-a-real-secret',
      },
    });

    const progress = await service.watchProgress.create({
      data: {
        userId: user.id,
        seriesId: 'series-104',
        lastWatchedVideoId: 'video-104-01',
        lastWatchedEpisodeNumber: 1,
        positionSeconds: 30,
      },
    });

    await service.user.delete({ where: { id: user.id } });

    const found = await service.watchProgress.findUnique({
      where: { id: progress.id },
    });

    expect(found).toBeNull();
  });
});
