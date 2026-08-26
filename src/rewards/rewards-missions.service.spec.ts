import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AppErrorCode } from '../common/errors/app-error-code';
import {
  fixtureEmail,
  TEST_FIXTURE_NAMESPACE,
} from '../common/testing/fixture-namespace.helpers';
import { PrismaService } from '../prisma/prisma.service';
import { RewardsMissionsService } from './rewards-missions.service';
import { RewardsWalletService } from './rewards-wallet.service';
import { RewardsWatchService } from './rewards-watch.service';
import {
  ONE_TIME_MISSION_PERIOD_KEY,
  REWARD_REASONS,
  REWARD_WATCH_CREDIT_SOURCES,
  WATCH_MISSION_DEFINITIONS,
} from './rewards.constants';
import {
  findSocialMissionDefinition,
  SOCIAL_MISSION_MIN_DWELL_SECONDS,
} from './social-missions.constants';

const TEST_TIMEZONE = 'Asia/Jakarta';

const INSTAGRAM_URL = 'https://www.instagram.com/redpanda';
const TIKTOK_URL = 'https://www.tiktok.com/@redpanda';
const YOUTUBE_URL = 'https://www.youtube.com/@redpanda';

/**
 * Work unit "REWARDS V1 EARN AND SPEND": integration spec for the two earn
 * paths, against the real database (the `RewardsService` precedent).
 *
 * HOW THE DWELL WINDOW IS SATISFIED WITHOUT SLEEPING FOR FIVE SECONDS. The
 * service compares `now` against the stored `openedAt`, and BOTH are
 * parameters here — `openMission`/`claimMission` take an explicit `now`. So a
 * test opens "six seconds ago" and claims "now" against real stored rows and
 * real arithmetic. Nothing is mocked and no clock is faked; the elapsed time
 * is chosen rather than waited for.
 *
 * `process.env` IS MUTATED in `beforeAll` and restored in `afterAll`, because
 * `RewardsMissionsService` reads the social catalog once in its constructor
 * (the `AdsConfigService` precedent). The values are set before any module is
 * compiled, and every fixture id is namespaced.
 */
describe('RewardsMissionsService', () => {
  let service: RewardsMissionsService;
  let watch: RewardsWatchService;
  let prisma: PrismaService;
  let userId: string;

  const originalEnv = { ...process.env };

  beforeAll(() => {
    process.env.REWARDS_SOCIAL_INSTAGRAM_URL = INSTAGRAM_URL;
    process.env.REWARDS_SOCIAL_TIKTOK_URL = TIKTOK_URL;
    process.env.REWARDS_SOCIAL_YOUTUBE_URL = YOUTUBE_URL;
    delete process.env.REWARDS_SOCIAL_FACEBOOK_URL;
  });

  afterAll(() => {
    process.env = { ...originalEnv };
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RewardsMissionsService,
        RewardsWalletService,
        RewardsWatchService,
        PrismaService,
        {
          provide: ConfigService,
          useValue: {
            get: () => ({ enabled: true, timezone: TEST_TIMEZONE }),
          },
        },
      ],
    }).compile();

    service = module.get(RewardsMissionsService);
    watch = module.get(RewardsWatchService);
    prisma = module.get(PrismaService);
    await prisma.onModuleInit();

    const user = await prisma.user.create({
      data: {
        email: fixtureEmail('rewards-missions'),
        passwordHash: 'irrelevant-for-this-spec',
      },
    });
    userId = user.id;
  });

  afterEach(async () => {
    await prisma.user.deleteMany({
      where: { email: { startsWith: TEST_FIXTURE_NAMESPACE } },
    });
    await prisma.onModuleDestroy();
  });

  const secondsAgo = (seconds: number): Date =>
    new Date(Date.now() - seconds * 1000);

  /** Opens the mission far enough in the past that the dwell window has passed. */
  const openLongEnoughAgo = (missionId: string) =>
    service.openMission(
      userId,
      missionId,
      secondsAgo(SOCIAL_MISSION_MIN_DWELL_SECONDS + 1),
    );

  /** Records `count` DISTINCT server-observed episode starts for today. */
  const startEpisodes = async (count: number): Promise<void> => {
    for (let index = 0; index < count; index += 1) {
      await watch.recordEpisodeStart({
        userId,
        videoId: `${TEST_FIXTURE_NAMESPACE}-video-${index}`,
        seriesId: `${TEST_FIXTURE_NAMESPACE}-series`,
        episodeNumber: index + 1,
      });
    }
  };

  describe('the served catalog', () => {
    it('CRITICAL: serves Instagram, TikTok and YouTube as claimable missions', async () => {
      const tasks = await service.buildMissionTasks(userId, new Date());
      const social = tasks.filter((task) => task.type === 'SOCIAL_FOLLOW');

      expect(social.map((task) => task.socialPlatform)).toEqual([
        'INSTAGRAM',
        'TIKTOK',
        'YOUTUBE',
      ]);

      for (const task of social) {
        expect(task.isClaimSupported).toBe(true);
        expect(task.destinationUrl).toMatch(/^https:\/\//);
        expect(task.status).toBe('AVAILABLE');
        expect(task.claimedAt).toBeNull();
      }
    });

    it('CRITICAL: never claims a social mission is a verified follow', async () => {
      const tasks = await service.buildMissionTasks(userId, new Date());

      for (const task of tasks.filter((t) => t.type === 'SOCIAL_FOLLOW')) {
        // The single most important assertion in this file. If this ever
        // becomes anything stronger, the backend is claiming evidence it does
        // not have.
        expect(task.verification).toBe('USER_CONFIRMED');
      }
    });

    it('omits a platform this deployment has not configured', async () => {
      const tasks = await service.buildMissionTasks(userId, new Date());

      // Facebook is deliberately unset in `beforeAll`. It must not appear at
      // all — not as a disabled tile, not with a null URL.
      expect(
        tasks.find((task) => task.id === 'task_social_facebook'),
      ).toBeUndefined();
    });

    it('serves the watch milestones with server-observed progress', async () => {
      const tasks = await service.buildMissionTasks(userId, new Date());
      const watchTasks = tasks.filter((task) => task.type === 'WATCH_EPISODES');

      expect(watchTasks).toHaveLength(WATCH_MISSION_DEFINITIONS.length);

      for (const task of watchTasks) {
        expect(task.verification).toBe('SERVER_OBSERVED');
        expect(task.progress).toEqual({
          current: 0,
          required: expect.any(Number) as number,
        });
        expect(task.resetsAt).toEqual(expect.any(String));
      }
    });
  });

  describe('social missions', () => {
    it.each([
      ['task_social_instagram', INSTAGRAM_URL],
      ['task_social_tiktok', TIKTOK_URL],
      ['task_social_youtube', YOUTUBE_URL],
    ])(
      'CRITICAL: %s pays its configured reward on a first claim',
      async (missionId, expectedUrl) => {
        const opened = await openLongEnoughAgo(missionId);
        expect(opened.destinationUrl).toBe(expectedUrl);

        const claim = await service.claimMission(userId, missionId);
        const definition = findSocialMissionDefinition(missionId)!;

        expect(claim.alreadyClaimed).toBe(false);
        expect(claim.awardedPoints).toBe(definition.rewardPoints);
        expect(claim.wallet.balancePoints).toBe(definition.rewardPoints);
        expect(claim.task.status).toBe('COMPLETED');
        expect(claim.task.claimedAt).toEqual(expect.any(String));
      },
    );

    it('CRITICAL: records the credit as an external social action, never a verified follow', async () => {
      await openLongEnoughAgo('task_social_instagram');
      await service.claimMission(userId, 'task_social_instagram');

      const entry = await prisma.rewardLedgerEntry.findFirstOrThrow({
        where: { userId },
      });

      expect(entry.reason).toBe(REWARD_REASONS.EXTERNAL_SOCIAL_ACTION);
      expect(entry.sourceId).toBe('task_social_instagram');
      expect(entry.idempotencyKey).toBe(
        'EXTERNAL_SOCIAL_ACTION:task_social_instagram',
      );
      expect(entry.metadata).toMatchObject({ verification: 'USER_CONFIRMED' });
    });

    it('CRITICAL: a second claim pays nothing and writes no second ledger row', async () => {
      await openLongEnoughAgo('task_social_instagram');
      const first = await service.claimMission(userId, 'task_social_instagram');
      const second = await service.claimMission(
        userId,
        'task_social_instagram',
      );

      expect(second.alreadyClaimed).toBe(true);
      expect(second.awardedPoints).toBe(0);
      expect(second.wallet.balancePoints).toBe(first.wallet.balancePoints);
      expect(await prisma.rewardLedgerEntry.count({ where: { userId } })).toBe(
        1,
      );
    });

    it('CRITICAL: re-opening the profile does not make the mission payable again', async () => {
      await openLongEnoughAgo('task_social_instagram');
      const first = await service.claimMission(userId, 'task_social_instagram');

      // The farming attempt: open it again, wait, claim again. The ledger key
      // carries no period, so there is nothing to reset.
      await openLongEnoughAgo('task_social_instagram');
      const second = await service.claimMission(
        userId,
        'task_social_instagram',
      );

      expect(second.alreadyClaimed).toBe(true);
      expect(second.wallet.balancePoints).toBe(first.wallet.balancePoints);
    });

    it('CRITICAL: two concurrent claims pay exactly once', async () => {
      await openLongEnoughAgo('task_social_instagram');

      const [a, b] = await Promise.all([
        service.claimMission(userId, 'task_social_instagram'),
        service.claimMission(userId, 'task_social_instagram'),
      ]);

      const paid = [a, b].filter((result) => result.awardedPoints > 0);
      expect(paid).toHaveLength(1);
      expect(await prisma.rewardLedgerEntry.count({ where: { userId } })).toBe(
        1,
      );

      const wallet = await prisma.rewardWallet.findUniqueOrThrow({
        where: { userId },
      });
      expect(wallet.balancePoints).toBe(
        findSocialMissionDefinition('task_social_instagram')!.rewardPoints,
      );
    });

    it('CRITICAL: refuses a claim from a client that never opened the link', async () => {
      await expect(
        service.claimMission(userId, 'task_social_instagram'),
      ).rejects.toMatchObject({
        code: AppErrorCode.REWARD_MISSION_NOT_STARTED,
      });

      expect(await prisma.rewardLedgerEntry.count({ where: { userId } })).toBe(
        0,
      );
    });

    it('refuses a claim made immediately after opening', async () => {
      await service.openMission(userId, 'task_social_instagram');

      await expect(
        service.claimMission(userId, 'task_social_instagram'),
      ).rejects.toMatchObject({ code: AppErrorCode.REWARD_MISSION_TOO_SOON });
    });

    it('counts opens without paying for them', async () => {
      await service.openMission(userId, 'task_social_instagram');
      await service.openMission(userId, 'task_social_instagram');

      const claim = await prisma.rewardMissionClaim.findUniqueOrThrow({
        where: {
          userId_missionId_periodKey: {
            userId,
            missionId: 'task_social_instagram',
            periodKey: ONE_TIME_MISSION_PERIOD_KEY,
          },
        },
      });

      expect(claim.openCount).toBe(2);
      expect(claim.claimedAt).toBeNull();
      expect(claim.awardedPoints).toBeNull();
      expect(await prisma.rewardLedgerEntry.count({ where: { userId } })).toBe(
        0,
      );
    });

    it('CRITICAL: refuses a mission id that is not in the catalog', async () => {
      // Arbitrary mission-id injection: an id the server has never heard of
      // must pay nothing and must not be treated as a zero-value success.
      await expect(
        service.claimMission(userId, 'task_social_pay_me_please'),
      ).rejects.toMatchObject({ code: AppErrorCode.REWARD_MISSION_NOT_FOUND });

      await expect(
        service.openMission(userId, '../../etc/passwd'),
      ).rejects.toMatchObject({ code: AppErrorCode.REWARD_MISSION_NOT_FOUND });

      expect(await prisma.rewardLedgerEntry.count({ where: { userId } })).toBe(
        0,
      );
    });

    it('refuses to open a real mission this deployment has not configured', async () => {
      await expect(
        service.openMission(userId, 'task_social_facebook'),
      ).rejects.toMatchObject({
        code: AppErrorCode.REWARD_MISSION_UNAVAILABLE,
      });
    });

    it('refuses to open a watch mission, which has nothing to open', async () => {
      await expect(
        service.openMission(userId, WATCH_MISSION_DEFINITIONS[0].id),
      ).rejects.toMatchObject({
        code: AppErrorCode.REWARD_MISSION_NOT_OPENABLE,
      });
    });
  });

  describe('watch missions', () => {
    const firstMission = WATCH_MISSION_DEFINITIONS[0];

    it('CRITICAL: refuses a claim before the milestone is reached', async () => {
      await startEpisodes(firstMission.requiredEpisodes - 1);

      await expect(
        service.claimMission(userId, firstMission.id),
      ).rejects.toMatchObject({
        code: AppErrorCode.REWARD_MISSION_NOT_COMPLETE,
      });

      expect(await prisma.rewardLedgerEntry.count({ where: { userId } })).toBe(
        0,
      );
    });

    it('CRITICAL: pays once the milestone is reached', async () => {
      await startEpisodes(firstMission.requiredEpisodes);

      const claim = await service.claimMission(userId, firstMission.id);

      expect(claim.awardedPoints).toBe(firstMission.rewardPoints);
      expect(claim.wallet.balancePoints).toBe(firstMission.rewardPoints);
      expect(claim.task.status).toBe('COMPLETED');
    });

    it('CRITICAL: replaying the same episode does not advance progress', async () => {
      // The farming attempt: hit the playback route for ONE episode as many
      // times as the milestone requires.
      for (
        let attempt = 0;
        attempt < firstMission.requiredEpisodes;
        attempt += 1
      ) {
        await watch.recordEpisodeStart({
          userId,
          videoId: `${TEST_FIXTURE_NAMESPACE}-same-video`,
          episodeNumber: 1,
        });
      }

      const periodKey = watch.currentPeriodKey();
      expect(await watch.countEpisodesStarted(userId, periodKey)).toBe(1);

      await expect(
        service.claimMission(userId, firstMission.id),
      ).rejects.toMatchObject({
        code: AppErrorCode.REWARD_MISSION_NOT_COMPLETE,
      });
    });

    it('CRITICAL: a second claim on the same reward day pays nothing', async () => {
      await startEpisodes(firstMission.requiredEpisodes);

      const first = await service.claimMission(userId, firstMission.id);
      const second = await service.claimMission(userId, firstMission.id);

      expect(second.alreadyClaimed).toBe(true);
      expect(second.awardedPoints).toBe(0);
      expect(second.wallet.balancePoints).toBe(first.wallet.balancePoints);
      expect(await prisma.rewardLedgerEntry.count({ where: { userId } })).toBe(
        1,
      );
    });

    it('CRITICAL: two concurrent claims pay exactly once', async () => {
      await startEpisodes(firstMission.requiredEpisodes);

      const results = await Promise.all([
        service.claimMission(userId, firstMission.id),
        service.claimMission(userId, firstMission.id),
      ]);

      expect(results.filter((r) => r.awardedPoints > 0)).toHaveLength(1);
      expect(await prisma.rewardLedgerEntry.count({ where: { userId } })).toBe(
        1,
      );
    });

    it('keys the ledger entry on the reward day, so tomorrow is claimable again', async () => {
      await startEpisodes(firstMission.requiredEpisodes);
      await service.claimMission(userId, firstMission.id);

      const entry = await prisma.rewardLedgerEntry.findFirstOrThrow({
        where: { userId },
      });
      const periodKey = watch.currentPeriodKey();

      expect(entry.reason).toBe(REWARD_REASONS.WATCH_MILESTONE);
      expect(entry.idempotencyKey).toBe(
        `WATCH_MILESTONE:${firstMission.id}:${periodKey}`,
      );
      expect(entry.metadata).toMatchObject({
        verification: 'SERVER_OBSERVED',
        periodKey,
      });
    });

    it('records the credit as a server-observed playback grant', async () => {
      await startEpisodes(1);

      const credit = await prisma.rewardWatchCredit.findFirstOrThrow({
        where: { userId },
      });

      expect(credit.source).toBe(REWARD_WATCH_CREDIT_SOURCES.PLAYBACK_GRANT);
      expect(credit.periodKey).toBe(watch.currentPeriodKey());
    });

    it('reports progress as it accumulates, clamped at the goal', async () => {
      await startEpisodes(firstMission.requiredEpisodes + 2);

      const tasks = await service.buildMissionTasks(userId, new Date());
      const task = tasks.find((t) => t.id === firstMission.id)!;

      expect(task.progress).toEqual({
        current: firstMission.requiredEpisodes,
        required: firstMission.requiredEpisodes,
      });
      expect(task.status).toBe('CLAIMABLE');
    });
  });
});
