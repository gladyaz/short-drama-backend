import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { InteractionsService } from './interactions.service';

/**
 * Integration-style spec (Phase 9, work unit 9-B2), following the
 * 8-B2/8-B4/9-B1 precedent: real `PrismaService` against the project's dev
 * SQLite database, self-cleaning via `afterEach` so it leaves no residue.
 */
describe('InteractionsService', () => {
  let service: InteractionsService;
  let prisma: PrismaService;

  const testIdPrefix = 'interactions-service-spec';
  let userId: string;
  let otherUserId: string;
  let videoId: string;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [InteractionsService, PrismaService],
    }).compile();

    service = module.get<InteractionsService>(InteractionsService);
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

    const video = await prisma.video.create({
      data: {
        id: `${testIdPrefix}-video-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        seriesId: `${testIdPrefix}-series`,
        title: 'Spec Video',
        episodeNumber: 1,
        channelName: 'Spec Channel',
        caption: 'Spec caption',
        category: 'drama',
        storageKey: 'Spec Series/1_subtitled.mp4',
        sourceLanguage: 'zh',
        hasEmbeddedIndonesianSubtitle: true,
        likeCount: 10,
      },
    });
    videoId = video.id;
  });

  afterEach(async () => {
    await prisma.userVideoInteraction.deleteMany({
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

  describe('like/unlike', () => {
    it('increments likeCount and sets isLiked true on first like', async () => {
      const result = await service.like(userId, videoId);

      expect(result).toEqual({ videoId, isLiked: true, likeCount: 11 });

      const interaction = await prisma.userVideoInteraction.findUnique({
        where: { userId_videoId: { userId, videoId } },
      });
      expect(interaction?.isLiked).toBe(true);
    });

    it('does not double-increment likeCount when liking an already-liked video', async () => {
      await service.like(userId, videoId);
      const result = await service.like(userId, videoId);

      expect(result).toEqual({ videoId, isLiked: true, likeCount: 11 });
    });

    it('decrements likeCount and sets isLiked false on unlike', async () => {
      await service.like(userId, videoId);
      const result = await service.unlike(userId, videoId);

      expect(result).toEqual({ videoId, isLiked: false, likeCount: 10 });

      const interaction = await prisma.userVideoInteraction.findUnique({
        where: { userId_videoId: { userId, videoId } },
      });
      expect(interaction?.isLiked).toBe(false);
    });

    it('floors likeCount at 0 and never decrements below it', async () => {
      // Drive likeCount down to 0 directly, then unlike once already liked.
      await prisma.video.update({
        where: { id: videoId },
        data: { likeCount: 0 },
      });
      await service.like(userId, videoId); // 0 -> 1

      const afterLike = await prisma.video.findUniqueOrThrow({
        where: { id: videoId },
      });
      expect(afterLike.likeCount).toBe(1);

      const result = await service.unlike(userId, videoId); // 1 -> 0
      expect(result.likeCount).toBe(0);

      // Unliking again (already unliked) must not push the counter negative.
      const secondUnlike = await service.unlike(userId, videoId);
      expect(secondUnlike.likeCount).toBe(0);
    });

    it('unliking a video that was never liked leaves likeCount untouched', async () => {
      const result = await service.unlike(userId, videoId);
      expect(result).toEqual({ videoId, isLiked: false, likeCount: 10 });
    });

    it('does not let one user liking a video affect another user state', async () => {
      await service.like(userId, videoId);
      const otherResult = await service.unlike(otherUserId, videoId);

      expect(otherResult.isLiked).toBe(false);
      expect(otherResult.likeCount).toBe(11);
    });

    it('keeps two users isLiked state on the same video fully independent', async () => {
      // userId likes the video; otherUserId never interacts with it. Each
      // user's own view (via listForUser) must reflect only their own state,
      // not leak the other user's isLiked value for the same shared video.
      await service.like(userId, videoId);
      await service.save(otherUserId, videoId);

      const userRows = await service.listForUser(userId);
      const otherUserRows = await service.listForUser(otherUserId);

      expect(userRows).toEqual([{ videoId, isLiked: true, isSaved: false }]);
      expect(otherUserRows).toEqual([
        { videoId, isLiked: false, isSaved: true },
      ]);
    });

    it('rejects like with VIDEO_NOT_FOUND when the video does not exist', async () => {
      await expect(
        service.like(userId, 'nonexistent-video-id'),
      ).rejects.toMatchObject({ code: 'VIDEO_NOT_FOUND' });

      try {
        await service.like(userId, 'nonexistent-video-id');
        fail('expected service.like to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(AppException);
        expect((error as AppException).getStatus()).toBe(HttpStatus.NOT_FOUND);
      }
    });

    it('rejects unlike with VIDEO_NOT_FOUND when the video does not exist', async () => {
      await expect(
        service.unlike(userId, 'nonexistent-video-id'),
      ).rejects.toBeInstanceOf(AppException);
    });

    /**
     * Phase 9, work unit 9-M3: regression coverage for the known
     * read-then-write lost-update race flagged during 8P-5 validation.
     * `unlike()`'s decrement reads `Video.likeCount` and writes back
     * `current - 1` inside its `$transaction`, unlike `like()`'s atomic SQL
     * `{ increment: 1 }`. Under true concurrent unlikes on the SAME video
     * (two different users, both currently liked), if Postgres's
     * `READ COMMITTED` isolation lets both transactions read the same
     * pre-decrement `likeCount` before either commits, only one decrement
     * "sticks" and the counter ends up N-1 instead of the correct N-2 — a
     * lost update. This test fires real concurrent `unlike()` calls via
     * `Promise.all` and asserts the counter decreases by exactly the number
     * of concurrent unlikes, regardless of whether the current
     * implementation is vulnerable.
     */
    it('correctly decrements likeCount by exactly N under N concurrent unlikes on the same video', async () => {
      const concurrentUserIds: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const user = await prisma.user.create({
          data: {
            email: `${testIdPrefix}-concurrent-${i}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
            passwordHash: 'irrelevant-for-this-spec',
          },
        });
        concurrentUserIds.push(user.id);
      }

      const startingLikeCount = concurrentUserIds.length + 5;
      await prisma.video.update({
        where: { id: videoId },
        data: { likeCount: startingLikeCount },
      });

      // Every concurrent user must actually be in the "liked" state first,
      // so each concurrent unlike() call performs a real decrement (not a
      // no-op short-circuit).
      await Promise.all(
        concurrentUserIds.map((id) => service.like(id, videoId)),
      );

      const beforeUnlike = await prisma.video.findUniqueOrThrow({
        where: { id: videoId },
      });

      await Promise.all(
        concurrentUserIds.map((id) => service.unlike(id, videoId)),
      );

      const afterUnlike = await prisma.video.findUniqueOrThrow({
        where: { id: videoId },
      });

      expect(afterUnlike.likeCount).toBe(
        beforeUnlike.likeCount - concurrentUserIds.length,
      );

      await prisma.userVideoInteraction.deleteMany({
        where: { userId: { in: concurrentUserIds } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: concurrentUserIds } },
      });
    });
  });

  describe('save/unsave', () => {
    it('sets isSaved true on save and does not touch isLiked/likeCount', async () => {
      const result = await service.save(userId, videoId);
      expect(result).toEqual({ videoId, isSaved: true });

      const video = await prisma.video.findUniqueOrThrow({
        where: { id: videoId },
      });
      expect(video.likeCount).toBe(10);
    });

    it('sets isSaved false on unsave', async () => {
      await service.save(userId, videoId);
      const result = await service.unsave(userId, videoId);
      expect(result).toEqual({ videoId, isSaved: false });
    });

    it('rejects save with VIDEO_NOT_FOUND when the video does not exist', async () => {
      await expect(
        service.save(userId, 'nonexistent-video-id'),
      ).rejects.toMatchObject({ code: 'VIDEO_NOT_FOUND' });
    });
  });

  describe('listForUser', () => {
    it('returns all interaction rows for the user', async () => {
      await service.like(userId, videoId);
      await service.save(userId, videoId);

      const result = await service.listForUser(userId);

      expect(result).toEqual([{ videoId, isLiked: true, isSaved: true }]);
    });

    it('returns an empty array for a user with no interactions', async () => {
      const result = await service.listForUser(userId);
      expect(result).toEqual([]);
    });
  });
});
