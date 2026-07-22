import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { ProgressService } from './progress.service';

/**
 * Integration-style spec (Phase 9, work unit 9-B2), following the
 * 8-B2/8-B4/9-B1 precedent: real `PrismaService` against the project's dev
 * SQLite database, self-cleaning via `afterEach`.
 */
describe('ProgressService', () => {
  let service: ProgressService;
  let prisma: PrismaService;

  const testIdPrefix = 'progress-service-spec';
  let userId: string;
  let otherUserId: string;
  let videoId: string;
  let secondVideoId: string;
  const seriesId = `${testIdPrefix}-series`;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ProgressService, PrismaService],
    }).compile();

    service = module.get<ProgressService>(ProgressService);
    prisma = module.get<PrismaService>(PrismaService);
    await prisma.onModuleInit();

    const user = await prisma.user.create({
      data: {
        email: `${testIdPrefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
        passwordHash: 'irrelevant-for-this-spec',
      },
    });
    userId = user.id;

    const otherUser = await prisma.user.create({
      data: {
        email: `${testIdPrefix}-other-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
        passwordHash: 'irrelevant-for-this-spec',
      },
    });
    otherUserId = otherUser.id;

    const makeVideo = async (suffix: string) =>
      prisma.video.create({
        data: {
          id: `${testIdPrefix}-video-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          seriesId,
          title: 'Spec Video',
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

    videoId = (await makeVideo('one')).id;
    secondVideoId = (await makeVideo('two')).id;
  });

  afterEach(async () => {
    await prisma.watchProgress.deleteMany({
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

  describe('upsertProgress', () => {
    it('creates a new progress row on first call', async () => {
      const result = await service.upsertProgress(userId, seriesId, {
        videoId,
        episodeNumber: 1,
        positionSeconds: 30,
        durationSeconds: 300,
      });

      expect(result).toEqual({
        seriesId,
        videoId,
        episodeNumber: 1,
        positionSeconds: 30,
        durationSeconds: 300,
      });
    });

    it('updates the existing row on a second call for the same user+series', async () => {
      await service.upsertProgress(userId, seriesId, {
        videoId,
        episodeNumber: 1,
        positionSeconds: 30,
      });

      const result = await service.upsertProgress(userId, seriesId, {
        videoId: secondVideoId,
        episodeNumber: 2,
        positionSeconds: 90,
        durationSeconds: 300,
      });

      expect(result).toEqual({
        seriesId,
        videoId: secondVideoId,
        episodeNumber: 2,
        positionSeconds: 90,
        durationSeconds: 300,
      });

      const rows = await prisma.watchProgress.findMany({
        where: { userId, seriesId },
      });
      expect(rows).toHaveLength(1);
    });

    it('keeps two users watch progress on the same series fully independent', async () => {
      // Both users progress through the exact same series, but each stops
      // at a different episode/position. Neither upsert should affect the
      // other's row (enforced by the (userId, seriesId) unique constraint),
      // and each user's own listForUser view must reflect only their own
      // progress, not the other user's.
      await service.upsertProgress(userId, seriesId, {
        videoId,
        episodeNumber: 1,
        positionSeconds: 30,
      });
      await service.upsertProgress(otherUserId, seriesId, {
        videoId: secondVideoId,
        episodeNumber: 2,
        positionSeconds: 90,
      });

      const userRows = await service.listForUser(userId);
      const otherUserRows = await service.listForUser(otherUserId);

      expect(userRows).toEqual([
        {
          seriesId,
          videoId,
          episodeNumber: 1,
          positionSeconds: 30,
          durationSeconds: undefined,
        },
      ]);
      expect(otherUserRows).toEqual([
        {
          seriesId,
          videoId: secondVideoId,
          episodeNumber: 2,
          positionSeconds: 90,
          durationSeconds: undefined,
        },
      ]);
    });

    it('rejects with VIDEO_NOT_FOUND when the body videoId does not exist', async () => {
      await expect(
        service.upsertProgress(userId, seriesId, {
          videoId: 'nonexistent-video-id',
          episodeNumber: 1,
          positionSeconds: 0,
        }),
      ).rejects.toMatchObject({ code: 'VIDEO_NOT_FOUND' });

      try {
        await service.upsertProgress(userId, seriesId, {
          videoId: 'nonexistent-video-id',
          episodeNumber: 1,
          positionSeconds: 0,
        });
        fail('expected service.upsertProgress to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(AppException);
        expect((error as AppException).getStatus()).toBe(HttpStatus.NOT_FOUND);
      }

      const rows = await prisma.watchProgress.findMany({
        where: { userId, seriesId },
      });
      expect(rows).toHaveLength(0);
    });
  });

  describe('listForUser', () => {
    it('returns all progress rows for the user', async () => {
      await service.upsertProgress(userId, seriesId, {
        videoId,
        episodeNumber: 1,
        positionSeconds: 30,
      });

      const result = await service.listForUser(userId);

      expect(result).toEqual([
        {
          seriesId,
          videoId,
          episodeNumber: 1,
          positionSeconds: 30,
          durationSeconds: undefined,
        },
      ]);
    });

    it('returns an empty array for a user with no progress rows', async () => {
      const result = await service.listForUser(userId);
      expect(result).toEqual([]);
    });
  });
});
