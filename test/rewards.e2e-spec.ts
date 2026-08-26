import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import type { AuthResponseDto } from './../src/auth/auth.types';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { e2eSuiteBootBudgetMs } from './../src/common/testing/e2e-boot-budget.helpers';
import type { EntitlementStatusDto } from './../src/entitlements/entitlement.types';
import { PrismaService } from './../src/prisma/prisma.service';
import {
  CHECK_IN_REWARD_CURVE,
  findRedemptionOffer,
} from './../src/rewards/rewards.constants';
import type {
  ActivePerksDto,
  CheckInResponseDto,
  MissionClaimResponseDto,
  MissionOpenResponseDto,
  PerkConsumeResponseDto,
  RedeemResponseDto,
  RewardLedgerPageDto,
  RewardsSnapshotDto,
} from './../src/rewards/rewards.types';

interface ErrorResponseBody {
  statusCode: number;
  code: string;
  message: string;
}

const INSTAGRAM_URL = 'https://www.instagram.com/redpanda';
const TIKTOK_URL = 'https://www.tiktok.com/@redpanda';
const YOUTUBE_URL = 'https://www.youtube.com/@redpanda';

const SKIP_OFFER_ID = 'redeem_skip_next_ad';

/**
 * e2e coverage for the `/rewards/*` surface, hitting real HTTP against the
 * real test database.
 *
 * Split into two apps because `REWARDS_ENABLED` and `DEV_TOOLS_ENABLED` are
 * read once at `ConfigModule` bootstrap (see `src/config/configuration.ts`),
 * following the `entitlements.e2e-spec.ts` precedent exactly: the first app
 * models the DEFAULT, production-safe posture (both flags unset, matching
 * what this repository ships), and the second opts in to exercise the real
 * behaviour end to end.
 */
describe('Rewards (e2e)', () => {
  const emailPrefix = 'rewards-e2e-spec';
  const uniqueEmail = (label: string): string =>
    `${emailPrefix}-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  const buildApp = async (): Promise<{
    app: INestApplication<App>;
    prisma: PrismaService;
  }> => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = moduleFixture.createNestApplication<INestApplication<App>>();
    app.useGlobalFilters(new AppExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    return { app, prisma: moduleFixture.get<PrismaService>(PrismaService) };
  };

  const registerUser = async (
    app: INestApplication<App>,
    label: string,
  ): Promise<{ accessToken: string; userId: string }> => {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: uniqueEmail(label), password: 'correct-horse-battery' })
      .expect(HttpStatus.CREATED);

    const body = response.body as AuthResponseDto;
    return { accessToken: body.accessToken, userId: body.user.id };
  };

  describe('with REWARDS_ENABLED unset (default, production-safe posture)', () => {
    let app: INestApplication<App>;
    let prisma: PrismaService;
    let accessToken: string;

    beforeAll(async () => {
      delete process.env.REWARDS_ENABLED;
      delete process.env.DEV_TOOLS_ENABLED;

      ({ app, prisma } = await buildApp());
      ({ accessToken } = await registerUser(app, 'disabled'));
    }, e2eSuiteBootBudgetMs(1));

    afterAll(async () => {
      await prisma.user.deleteMany({
        where: { email: { contains: emailPrefix } },
      });
      await app.close();
    });

    it('CRITICAL: answers 503 REWARDS_DISABLED on every rewards route', async () => {
      const routes: ['get' | 'post', string][] = [
        ['get', '/rewards/snapshot'],
        ['post', '/rewards/check-in'],
        ['get', '/rewards/ledger'],
        // Work unit "REWARDS V1 EARN AND SPEND": the new surface answers the
        // same way. A feature that ships dark must not expose HALF of itself.
        ['post', '/rewards/missions/task_social_instagram/open'],
        ['post', '/rewards/missions/task_social_instagram/claim'],
        ['get', '/rewards/perks'],
        ['post', '/rewards/perks/some-perk-id/consume'],
      ];

      for (const [method, path] of routes) {
        const response = await request(app.getHttpServer())
          [method](path)
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(HttpStatus.SERVICE_UNAVAILABLE);

        expect((response.body as ErrorResponseBody).code).toBe(
          'REWARDS_DISABLED',
        );
      }
    });

    it('CRITICAL: writes nothing while disabled', async () => {
      await request(app.getHttpServer())
        .post('/rewards/check-in')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.SERVICE_UNAVAILABLE);

      expect(await prisma.rewardLedgerEntry.count()).toBe(0);
      expect(await prisma.rewardWallet.count()).toBe(0);
    });

    it('still requires authentication, and answers 401 before the feature flag', async () => {
      // The auth guard runs first, so an anonymous caller cannot use the
      // disabled-feature response to probe which features exist.
      await request(app.getHttpServer())
        .get('/rewards/snapshot')
        .expect(HttpStatus.UNAUTHORIZED);
    });
  });

  describe('with REWARDS_ENABLED=true', () => {
    let app: INestApplication<App>;
    let prisma: PrismaService;
    let accessToken: string;
    let userId: string;
    /** A second account, registered once — see the account budget note below. */
    let v1AccessToken: string;
    let v1UserId: string;

    beforeAll(async () => {
      process.env.REWARDS_ENABLED = 'true';
      process.env.DEV_TOOLS_ENABLED = 'true';
      // Work unit "REWARDS V1 EARN AND SPEND": the social catalog is read
      // from `process.env` once, when the module is constructed, so these
      // must be set BEFORE `buildApp()`.
      process.env.REWARDS_SOCIAL_INSTAGRAM_URL = INSTAGRAM_URL;
      process.env.REWARDS_SOCIAL_TIKTOK_URL = TIKTOK_URL;
      process.env.REWARDS_SOCIAL_YOUTUBE_URL = YOUTUBE_URL;
      delete process.env.REWARDS_SOCIAL_FACEBOOK_URL;

      ({ app, prisma } = await buildApp());
      ({ accessToken, userId } = await registerUser(app, 'enabled'));
      ({ accessToken: v1AccessToken, userId: v1UserId } = await registerUser(
        app,
        'v1',
      ));
    }, e2eSuiteBootBudgetMs(1));

    afterAll(async () => {
      await prisma.user.deleteMany({
        where: { email: { contains: emailPrefix } },
      });
      await app.close();
      delete process.env.REWARDS_ENABLED;
      delete process.env.DEV_TOOLS_ENABLED;
      delete process.env.REWARDS_SOCIAL_INSTAGRAM_URL;
      delete process.env.REWARDS_SOCIAL_TIKTOK_URL;
      delete process.env.REWARDS_SOCIAL_YOUTUBE_URL;
    });

    const auth = () => `Bearer ${accessToken}`;

    it('rejects an unauthenticated snapshot request', async () => {
      await request(app.getHttpServer())
        .get('/rewards/snapshot')
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('serves a server-authoritative snapshot for a fresh account', async () => {
      const response = await request(app.getHttpServer())
        .get('/rewards/snapshot')
        .set('Authorization', auth())
        .expect(HttpStatus.OK);

      const snapshot = response.body as RewardsSnapshotDto;
      expect(snapshot.wallet.balancePoints).toBe(0);
      expect(snapshot.wallet.isServerAuthoritative).toBe(true);
      expect(snapshot.dailyCheckIn.isClaimSupported).toBe(true);
      expect(snapshot.dailyCheckIn.days).toHaveLength(7);
      expect(snapshot.watchTime).toBeNull();
      expect(snapshot.redemptions.length).toBeGreaterThan(0);
      // Work unit "REWARDS V1 EARN AND SPEND": the social and watch missions
      // ARE claimable now, and every claimable task must state how strong its
      // evidence is. What is still unclaimable must say why — see
      // docs/rewards-api-contract.md section 6.
      for (const task of snapshot.tasks) {
        if (task.isClaimSupported) {
          expect(['USER_CONFIRMED', 'SERVER_OBSERVED']).toContain(
            task.verification,
          );
        } else {
          expect(task.unsupportedReason).toBeDefined();
        }
      }
    });

    it('credits the first check-in and reflects it in the snapshot', async () => {
      const response = await request(app.getHttpServer())
        .post('/rewards/check-in')
        .set('Authorization', auth())
        .expect(HttpStatus.OK);

      const body = response.body as CheckInResponseDto;
      expect(body.alreadyCheckedIn).toBe(false);
      expect(body.awardedPoints).toBe(CHECK_IN_REWARD_CURVE[0]);
      expect(body.wallet.balancePoints).toBe(CHECK_IN_REWARD_CURVE[0]);

      const snapshot = await request(app.getHttpServer())
        .get('/rewards/snapshot')
        .set('Authorization', auth())
        .expect(HttpStatus.OK);
      expect(
        (snapshot.body as RewardsSnapshotDto).dailyCheckIn.isTodayClaimed,
      ).toBe(true);
    });

    it('CRITICAL: a repeat check-in is a 200 no-op, not a second payment', async () => {
      const response = await request(app.getHttpServer())
        .post('/rewards/check-in')
        .set('Authorization', auth())
        .expect(HttpStatus.OK);

      const body = response.body as CheckInResponseDto;
      expect(body.alreadyCheckedIn).toBe(true);
      expect(body.awardedPoints).toBe(0);
      expect(body.wallet.balancePoints).toBe(CHECK_IN_REWARD_CURVE[0]);

      expect(await prisma.rewardLedgerEntry.count({ where: { userId } })).toBe(
        1,
      );
    });

    it('returns the ledger, newest first', async () => {
      const response = await request(app.getHttpServer())
        .get('/rewards/ledger')
        .set('Authorization', auth())
        .expect(HttpStatus.OK);

      const page = response.body as RewardLedgerPageDto;
      expect(page.entries).toHaveLength(1);
      expect(page.entries[0]).toMatchObject({
        reason: 'DAILY_CHECK_IN',
        deltaPoints: CHECK_IN_REWARD_CURVE[0],
      });
    });

    it('rejects an out-of-range ledger limit', async () => {
      await request(app.getHttpServer())
        .get('/rewards/ledger?limit=9999')
        .set('Authorization', auth())
        .expect(HttpStatus.BAD_REQUEST);
    });

    it('CRITICAL: refuses a redemption the balance cannot cover', async () => {
      const response = await request(app.getHttpServer())
        .post('/rewards/redemptions')
        .set('Authorization', auth())
        .send({ offerId: 'redeem_vip_1d', idempotencyKey: 'e2e-too-poor' })
        .expect(HttpStatus.CONFLICT);

      expect((response.body as ErrorResponseBody).code).toBe(
        'INSUFFICIENT_REWARD_POINTS',
      );
    });

    it('CRITICAL: rejects a request that tries to supply its own economics', async () => {
      // `forbidNonWhitelisted` means a client cannot smuggle an amount past
      // the DTO — the server decides every value, and a request that argues
      // is refused outright rather than silently ignored.
      const response = await request(app.getHttpServer())
        .post('/rewards/redemptions')
        .set('Authorization', auth())
        .send({
          offerId: 'redeem_vip_1d',
          idempotencyKey: 'e2e-injection',
          costPoints: 1,
          balancePoints: 999999,
        })
        .expect(HttpStatus.BAD_REQUEST);

      expect(response.body).toBeDefined();
    });

    it('CRITICAL: redeems points into a real premium entitlement, atomically', async () => {
      await request(app.getHttpServer())
        .post('/dev/rewards/grant')
        .set('Authorization', auth())
        .send({ points: 1500, idempotencyKey: 'e2e-demo-grant' })
        .expect(HttpStatus.OK);

      const response = await request(app.getHttpServer())
        .post('/rewards/redemptions')
        .set('Authorization', auth())
        .send({ offerId: 'redeem_vip_1d', idempotencyKey: 'e2e-redeem-1' })
        .expect(HttpStatus.OK);

      const body = response.body as RedeemResponseDto;
      expect(body.status).toBe('FULFILLED');
      expect(body.replayed).toBe(false);
      expect(body.costPoints).toBe(1000);
      expect(body.wallet.balancePoints).toBe(
        1500 + CHECK_IN_REWARD_CURVE[0] - 1000,
      );

      // The premium is visible through the EXISTING entitlement endpoint —
      // proof that redemption went through the shared entitlement system and
      // did not invent a parallel one.
      const entitlement = await request(app.getHttpServer())
        .get('/users/me/entitlement')
        .set('Authorization', auth())
        .expect(HttpStatus.OK);
      expect((entitlement.body as EntitlementStatusDto).isPremium).toBe(true);
    });

    it('CRITICAL: replaying a redemption returns the original receipt and charges once', async () => {
      const before = await request(app.getHttpServer())
        .get('/rewards/snapshot')
        .set('Authorization', auth())
        .expect(HttpStatus.OK);

      const response = await request(app.getHttpServer())
        .post('/rewards/redemptions')
        .set('Authorization', auth())
        .send({ offerId: 'redeem_vip_1d', idempotencyKey: 'e2e-redeem-1' })
        .expect(HttpStatus.OK);

      const body = response.body as RedeemResponseDto;
      expect(body.replayed).toBe(true);
      expect(body.wallet.balancePoints).toBe(
        (before.body as RewardsSnapshotDto).wallet.balancePoints,
      );
    });

    it('refuses an idempotency key reused for a different offer', async () => {
      const response = await request(app.getHttpServer())
        .post('/rewards/redemptions')
        .set('Authorization', auth())
        .send({ offerId: 'redeem_vip_3d', idempotencyKey: 'e2e-redeem-1' })
        .expect(HttpStatus.CONFLICT);

      expect((response.body as ErrorResponseBody).code).toBe(
        'REWARD_IDEMPOTENCY_KEY_REUSED',
      );
    });

    it('refuses a coming-soon offer server-side', async () => {
      const response = await request(app.getHttpServer())
        .post('/rewards/redemptions')
        .set('Authorization', auth())
        .send({ offerId: 'redeem_vip_7d', idempotencyKey: 'e2e-coming-soon' })
        .expect(HttpStatus.CONFLICT);

      expect((response.body as ErrorResponseBody).code).toBe(
        'REWARD_OFFER_UNAVAILABLE',
      );
    });

    it('refuses an unknown offer', async () => {
      await request(app.getHttpServer())
        .post('/rewards/redemptions')
        .set('Authorization', auth())
        .send({ offerId: 'redeem_nope', idempotencyKey: 'e2e-unknown-offer' })
        .expect(HttpStatus.NOT_FOUND);
    });

    it('CRITICAL: the ledger still reconciles with the projection after every movement', async () => {
      const response = await request(app.getHttpServer())
        .get('/dev/rewards/reconcile')
        .set('Authorization', auth())
        .expect(HttpStatus.OK);

      expect(response.body).toMatchObject({ isConsistent: true });
    });

    it("CRITICAL: one account can never read or spend another account's balance", async () => {
      const other = await registerUser(app, 'isolation');

      const snapshot = await request(app.getHttpServer())
        .get('/rewards/snapshot')
        .set('Authorization', `Bearer ${other.accessToken}`)
        .expect(HttpStatus.OK);

      // A brand-new account sees its own zero balance, never the first
      // user's — the user id comes from the verified token, not the request.
      expect((snapshot.body as RewardsSnapshotDto).wallet.balancePoints).toBe(
        0,
      );

      const ledger = await request(app.getHttpServer())
        .get('/rewards/ledger')
        .set('Authorization', `Bearer ${other.accessToken}`)
        .expect(HttpStatus.OK);
      expect((ledger.body as RewardLedgerPageDto).entries).toHaveLength(0);
    });

    // -----------------------------------------------------------------
    // Work unit "REWARDS V1 EARN AND SPEND"
    //
    // ACCOUNT BUDGET. `POST /auth/register` is limited to 3 per 10 minutes
    // per IP, and this app instance already spends two of those (the suite's
    // main account and the isolation account below). Every test here
    // therefore reuses `accessToken` or the single extra `v1` account
    // registered in `beforeAll` — registering per test would make the suite
    // fail on the fourth one for a reason that has nothing to do with
    // rewards.
    // -----------------------------------------------------------------

    it('CRITICAL: serves the configured social missions, and never claims they are verified', async () => {
      const response = await request(app.getHttpServer())
        .get('/rewards/snapshot')
        .set('Authorization', auth())
        .expect(HttpStatus.OK);

      const social = (response.body as RewardsSnapshotDto).tasks.filter(
        (task) => task.type === 'SOCIAL_FOLLOW',
      );

      expect(social.map((task) => task.socialPlatform)).toEqual([
        'INSTAGRAM',
        'TIKTOK',
        'YOUTUBE',
      ]);
      expect(social.map((task) => task.destinationUrl)).toEqual([
        INSTAGRAM_URL,
        TIKTOK_URL,
        YOUTUBE_URL,
      ]);

      for (const task of social) {
        // The honesty flag, asserted on the wire and not only in a unit test.
        expect(task.verification).toBe('USER_CONFIRMED');
        expect(task.isClaimSupported).toBe(true);
      }

      // Facebook is not configured in this app, so it is not served at all.
      expect(
        (response.body as RewardsSnapshotDto).tasks.find(
          (task) => task.id === 'task_social_facebook',
        ),
      ).toBeUndefined();
    });

    it('CRITICAL: refuses a social claim from a client that never opened the link', async () => {
      const before = await prisma.rewardLedgerEntry.count({
        where: { userId: v1UserId },
      });

      const response = await request(app.getHttpServer())
        .post('/rewards/missions/task_social_tiktok/claim')
        .set('Authorization', `Bearer ${v1AccessToken}`)
        .expect(HttpStatus.CONFLICT);

      expect((response.body as ErrorResponseBody).code).toBe(
        'REWARD_MISSION_NOT_STARTED',
      );
      expect(
        await prisma.rewardLedgerEntry.count({ where: { userId: v1UserId } }),
      ).toBe(before);
    });

    it('CRITICAL: opens then claims a social mission exactly once', async () => {
      const opened = await request(app.getHttpServer())
        .post('/rewards/missions/task_social_instagram/open')
        .set('Authorization', `Bearer ${v1AccessToken}`)
        .expect(HttpStatus.OK);

      const openBody = opened.body as MissionOpenResponseDto;
      expect(openBody.destinationUrl).toBe(INSTAGRAM_URL);
      expect(openBody.claimableAfter > openBody.openedAt).toBe(true);

      // The route enforces a short dwell window. Back-date the RECORDED open
      // rather than sleeping through it — the rule under test is the server's
      // arithmetic over stored state, not the passage of wall-clock time.
      await prisma.rewardMissionClaim.updateMany({
        where: { userId: v1UserId, missionId: 'task_social_instagram' },
        data: { openedAt: new Date(Date.now() - 60_000) },
      });

      const first = await request(app.getHttpServer())
        .post('/rewards/missions/task_social_instagram/claim')
        .set('Authorization', `Bearer ${v1AccessToken}`)
        .expect(HttpStatus.OK);

      const firstBody = first.body as MissionClaimResponseDto;
      expect(firstBody.alreadyClaimed).toBe(false);
      expect(firstBody.awardedPoints).toBeGreaterThan(0);
      expect(firstBody.task.verification).toBe('USER_CONFIRMED');

      const second = await request(app.getHttpServer())
        .post('/rewards/missions/task_social_instagram/claim')
        .set('Authorization', `Bearer ${v1AccessToken}`)
        .expect(HttpStatus.OK);

      const secondBody = second.body as MissionClaimResponseDto;
      expect(secondBody.alreadyClaimed).toBe(true);
      expect(secondBody.awardedPoints).toBe(0);
      expect(secondBody.wallet.balancePoints).toBe(
        firstBody.wallet.balancePoints,
      );
    });

    it('CRITICAL: refuses a redemption the balance cannot cover, and issues no perk', async () => {
      // `v1` has exactly one social reward at this point, which is less than
      // any offer costs.
      const response = await request(app.getHttpServer())
        .post('/rewards/redemptions')
        .set('Authorization', `Bearer ${v1AccessToken}`)
        .send({ offerId: SKIP_OFFER_ID, idempotencyKey: 'e2e-perk-poor-001' })
        .expect(HttpStatus.CONFLICT);

      expect((response.body as ErrorResponseBody).code).toBe(
        'INSUFFICIENT_REWARD_POINTS',
      );
      expect(
        await prisma.rewardPerk.count({ where: { userId: v1UserId } }),
      ).toBe(0);
    });

    it('CRITICAL: refuses a mission id that is not in the catalog', async () => {
      const response = await request(app.getHttpServer())
        .post('/rewards/missions/task_social_give_me_points/claim')
        .set('Authorization', auth())
        .expect(HttpStatus.NOT_FOUND);

      expect((response.body as ErrorResponseBody).code).toBe(
        'REWARD_MISSION_NOT_FOUND',
      );
    });

    it('refuses a real mission this deployment has not configured', async () => {
      const response = await request(app.getHttpServer())
        .post('/rewards/missions/task_social_facebook/open')
        .set('Authorization', auth())
        .expect(HttpStatus.CONFLICT);

      expect((response.body as ErrorResponseBody).code).toBe(
        'REWARD_MISSION_UNAVAILABLE',
      );
    });

    it('CRITICAL: buys an ad-skip perk, reports it to the ad gate, and spends it once', async () => {
      const offer = findRedemptionOffer(SKIP_OFFER_ID)!;

      const before = await request(app.getHttpServer())
        .get('/rewards/snapshot')
        .set('Authorization', auth())
        .expect(HttpStatus.OK);
      const balanceBefore = (before.body as RewardsSnapshotDto).wallet
        .balancePoints;

      const redeemed = await request(app.getHttpServer())
        .post('/rewards/redemptions')
        .set('Authorization', auth())
        .send({ offerId: SKIP_OFFER_ID, idempotencyKey: 'e2e-perk-buy-0001' })
        .expect(HttpStatus.OK);

      const receipt = redeemed.body as RedeemResponseDto;
      expect(receipt.perk).not.toBeNull();
      expect(receipt.wallet.balancePoints).toBe(
        balanceBefore - offer.costPoints,
      );
      // An ad perk buys no premium at all.
      expect(receipt.entitlementExpiresAt).toBeNull();
      expect(receipt.grantsDays).toBe(0);

      const perks = await request(app.getHttpServer())
        .get('/rewards/perks')
        .set('Authorization', auth())
        .expect(HttpStatus.OK);

      expect((perks.body as ActivePerksDto).skipNextInterstitial).toBe(true);

      // A different account must not be able to spend it.
      await request(app.getHttpServer())
        .post(`/rewards/perks/${receipt.perk!.id}/consume`)
        .set('Authorization', `Bearer ${v1AccessToken}`)
        .expect(HttpStatus.NOT_FOUND);

      const consumed = await request(app.getHttpServer())
        .post(`/rewards/perks/${receipt.perk!.id}/consume`)
        .set('Authorization', auth())
        .expect(HttpStatus.OK);

      const consumedBody = consumed.body as PerkConsumeResponseDto;
      expect(consumedBody.consumed).toBe(true);
      expect(consumedBody.perks.skipNextInterstitial).toBe(false);

      // A retried consume is a 200 no-op, not a failure to render.
      const again = await request(app.getHttpServer())
        .post(`/rewards/perks/${receipt.perk!.id}/consume`)
        .set('Authorization', auth())
        .expect(HttpStatus.OK);

      expect((again.body as PerkConsumeResponseDto).alreadyConsumed).toBe(true);
    });

    it('rejects every new route without a credential', async () => {
      const routes: ['get' | 'post', string][] = [
        ['post', '/rewards/missions/task_social_instagram/open'],
        ['post', '/rewards/missions/task_social_instagram/claim'],
        ['get', '/rewards/perks'],
        ['post', '/rewards/perks/anything/consume'],
      ];

      for (const [method, path] of routes) {
        await request(app.getHttpServer())
          [method](path)
          .expect(HttpStatus.UNAUTHORIZED);
      }
    });
  });

  describe('with REWARDS_ENABLED=true but DEV_TOOLS_ENABLED unset', () => {
    let app: INestApplication<App>;
    let prisma: PrismaService;
    let accessToken: string;

    beforeAll(async () => {
      process.env.REWARDS_ENABLED = 'true';
      delete process.env.DEV_TOOLS_ENABLED;

      ({ app, prisma } = await buildApp());
      ({ accessToken } = await registerUser(app, 'no-dev-tools'));
    }, e2eSuiteBootBudgetMs(1));

    afterAll(async () => {
      await prisma.user.deleteMany({
        where: { email: { contains: emailPrefix } },
      });
      await app.close();
      delete process.env.REWARDS_ENABLED;
    });

    it('CRITICAL: the dev point-grant route is unreachable without DEV_TOOLS_ENABLED', async () => {
      // Otherwise the demo shortcut would be a free-points endpoint in any
      // deployment that turned rewards on.
      const response = await request(app.getHttpServer())
        .post('/dev/rewards/grant')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ points: 5000, idempotencyKey: 'should-not-work' })
        .expect(HttpStatus.NOT_FOUND);

      expect((response.body as ErrorResponseBody).code).toBe(
        'DEV_TOOLS_DISABLED',
      );
      expect(await prisma.rewardLedgerEntry.count()).toBe(0);
    });

    it('leaves the real rewards routes working', async () => {
      await request(app.getHttpServer())
        .get('/rewards/snapshot')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK);
    });
  });
});
