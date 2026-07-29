import { Test, TestingModule } from '@nestjs/testing';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { ExportService } from './export.service';

/**
 * Integration-style spec (Phase 12, work unit 12C-B2), following the
 * `InteractionsService`/`ProgressService`/`EntitlementsService` precedent:
 * real `PrismaService` against the project's dev database, self-cleaning via
 * `afterEach`.
 */
describe('ExportService', () => {
  let service: ExportService;
  let prisma: PrismaService;

  const testIdPrefix = 'export-service-spec';
  const uniqueSuffix = (): string =>
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  let userId: string;
  let otherUserId: string;
  let videoId: string;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ExportService, PrismaService],
    }).compile();

    service = module.get<ExportService>(ExportService);
    prisma = module.get<PrismaService>(PrismaService);
    await prisma.onModuleInit();

    const user = await prisma.user.create({
      data: {
        email: `${testIdPrefix}-${uniqueSuffix()}@example.test`,
        passwordHash: 'irrelevant-for-this-spec',
        displayName: 'Export Spec User',
      },
    });
    userId = user.id;

    const otherUser = await prisma.user.create({
      data: {
        email: `${testIdPrefix}-other-${uniqueSuffix()}@example.test`,
        passwordHash: 'irrelevant-for-this-spec',
      },
    });
    otherUserId = otherUser.id;

    const video = await prisma.video.create({
      data: {
        id: `${testIdPrefix}-video-${uniqueSuffix()}`,
        seriesId: `${testIdPrefix}-series`,
        title: 'Export Spec Video',
        episodeNumber: 1,
        channelName: 'Spec Channel',
        caption: 'Spec caption',
        category: 'drama',
        storageKey: 'Spec Series/1_subtitled.mp4',
        sourceLanguage: 'zh',
        hasEmbeddedIndonesianSubtitle: true,
        likeCount: 0,
      },
    });
    videoId = video.id;
  });

  afterEach(async () => {
    await prisma.userVideoInteraction.deleteMany({
      where: { user: { email: { contains: testIdPrefix } } },
    });
    await prisma.watchProgress.deleteMany({
      where: { user: { email: { contains: testIdPrefix } } },
    });
    await prisma.entitlement.deleteMany({
      where: { user: { email: { contains: testIdPrefix } } },
    });
    await prisma.video.deleteMany({
      where: { id: { contains: testIdPrefix } },
    });
    await prisma.user.deleteMany({
      where: { email: { contains: testIdPrefix } },
    });
    await prisma.onModuleDestroy();
  });

  it('exports profile fields plus empty arrays for a fresh account with no data', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

    const result = await service.exportForUser(userId);

    expect(result.profile).toEqual({
      email: user.email,
      displayName: 'Export Spec User',
      memberSince: user.createdAt.toISOString(),
    });
    expect(result.interactions).toEqual([]);
    expect(result.watchProgress).toEqual([]);
    expect(result.entitlements).toEqual([]);
    expect(typeof result.exportedAt).toBe('string');
    expect(new Date(result.exportedAt).toString()).not.toBe('Invalid Date');
  });

  it('exports a null displayName as null, not undefined/omitted', async () => {
    const result = await service.exportForUser(otherUserId);
    expect(result.profile.displayName).toBeNull();
  });

  it('exports interactions with a resolved videoTitle and no surrogate id/userId fields', async () => {
    await prisma.userVideoInteraction.create({
      data: { userId, videoId, isLiked: true, isSaved: true },
    });

    const result = await service.exportForUser(userId);

    expect(result.interactions).toHaveLength(1);
    const { updatedAt, ...rest } = result.interactions[0];
    expect(updatedAt).toEqual(expect.any(String));
    expect(rest).toEqual({
      videoId,
      videoTitle: 'Export Spec Video',
      isLiked: true,
      isSaved: true,
    });
  });

  it('resolves videoTitle to null for an interaction whose videoId no longer matches any catalog row', async () => {
    // UserVideoInteraction.videoId has no DB-level FK to Video (see the
    // schema comment) — an orphaned reference must be handled gracefully,
    // not crash.
    const orphanedVideoId = `${testIdPrefix}-orphan-${uniqueSuffix()}`;
    await prisma.userVideoInteraction.create({
      data: { userId, videoId: orphanedVideoId, isLiked: true, isSaved: false },
    });

    const result = await service.exportForUser(userId);

    expect(result.interactions).toHaveLength(1);
    const { updatedAt, ...rest } = result.interactions[0];
    expect(updatedAt).toEqual(expect.any(String));
    expect(rest).toEqual({
      videoId: orphanedVideoId,
      videoTitle: null,
      isLiked: true,
      isSaved: false,
    });
  });

  it('exports watch progress with a resolved videoTitle and no surrogate id/userId fields', async () => {
    await prisma.watchProgress.create({
      data: {
        userId,
        seriesId: `${testIdPrefix}-series`,
        lastWatchedVideoId: videoId,
        lastWatchedEpisodeNumber: 3,
        positionSeconds: 42,
        durationSeconds: 120,
      },
    });

    const result = await service.exportForUser(userId);

    expect(result.watchProgress).toHaveLength(1);
    const { updatedAt, ...rest } = result.watchProgress[0];
    expect(updatedAt).toEqual(expect.any(String));
    expect(rest).toEqual({
      seriesId: `${testIdPrefix}-series`,
      videoId,
      videoTitle: 'Export Spec Video',
      episodeNumber: 3,
      positionSeconds: 42,
      durationSeconds: 120,
    });
  });

  it('omits durationSeconds (undefined) rather than null when the underlying column is null', async () => {
    await prisma.watchProgress.create({
      data: {
        userId,
        seriesId: `${testIdPrefix}-series`,
        lastWatchedVideoId: videoId,
        lastWatchedEpisodeNumber: 1,
        positionSeconds: 5,
      },
    });

    const result = await service.exportForUser(userId);

    expect(result.watchProgress[0].durationSeconds).toBeUndefined();
    // `JSON.stringify` (what the real HTTP response actually serializes)
    // drops `undefined`-valued keys entirely, matching `ProgressResponseDto`'s
    // identical existing convention (`progress.service.ts`'s `toResponseDto`).
    expect(JSON.stringify(result.watchProgress[0])).not.toContain(
      'durationSeconds',
    );
  });

  it('exports entitlement history (not just current status), newest first, with no surrogate id/userId fields', async () => {
    const older = await prisma.entitlement.create({
      data: {
        userId,
        tier: 'premium',
        source: 'dev-grant',
        grantedAt: new Date('2026-01-01T00:00:00.000Z'),
        revokedAt: new Date('2026-01-15T00:00:00.000Z'),
      },
    });
    const newer = await prisma.entitlement.create({
      data: {
        userId,
        tier: 'premium',
        source: 'dev-grant',
        grantedAt: new Date('2026-02-01T00:00:00.000Z'),
      },
    });

    const result = await service.exportForUser(userId);

    expect(result.entitlements).toEqual([
      {
        tier: 'premium',
        source: 'dev-grant',
        grantedAt: newer.grantedAt.toISOString(),
        expiresAt: null,
        revokedAt: null,
      },
      {
        tier: 'premium',
        source: 'dev-grant',
        grantedAt: older.grantedAt.toISOString(),
        expiresAt: null,
        revokedAt: older.revokedAt?.toISOString() ?? null,
      },
    ]);
  });

  it('ownership isolation: never includes another account interactions/progress/entitlements', async () => {
    await prisma.userVideoInteraction.create({
      data: { userId: otherUserId, videoId, isLiked: true, isSaved: true },
    });
    await prisma.watchProgress.create({
      data: {
        userId: otherUserId,
        seriesId: `${testIdPrefix}-series`,
        lastWatchedVideoId: videoId,
        lastWatchedEpisodeNumber: 1,
        positionSeconds: 1,
      },
    });
    await prisma.entitlement.create({
      data: { userId: otherUserId, tier: 'premium', source: 'dev-grant' },
    });

    const result = await service.exportForUser(userId);

    expect(result.interactions).toEqual([]);
    expect(result.watchProgress).toEqual([]);
    expect(result.entitlements).toEqual([]);
  });

  it("rejects a nonexistent userId with the generic INVALID_ACCESS_TOKEN error (matches GET /auth/me's existing deleted-user precedent)", async () => {
    await expect(
      service.exportForUser('nonexistent-user-id'),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_TOKEN' });
    await expect(
      service.exportForUser('nonexistent-user-id'),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('never includes passwordHash, storageKey, or any surrogate row id anywhere in the serialized export', async () => {
    await prisma.userVideoInteraction.create({
      data: { userId, videoId, isLiked: true, isSaved: true },
    });
    await prisma.watchProgress.create({
      data: {
        userId,
        seriesId: `${testIdPrefix}-series`,
        lastWatchedVideoId: videoId,
        lastWatchedEpisodeNumber: 1,
        positionSeconds: 1,
      },
    });
    const entitlement = await prisma.entitlement.create({
      data: { userId, tier: 'premium', source: 'dev-grant' },
    });
    const interaction = await prisma.userVideoInteraction.findUniqueOrThrow({
      where: { userId_videoId: { userId, videoId } },
    });

    const result = await service.exportForUser(userId);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('irrelevant-for-this-spec');
    expect(serialized).not.toContain('Spec Series/1_subtitled.mp4');
    expect(serialized).not.toContain(userId);
    expect(serialized).not.toContain(entitlement.id);
    expect(serialized).not.toContain(interaction.id);
  });
});
