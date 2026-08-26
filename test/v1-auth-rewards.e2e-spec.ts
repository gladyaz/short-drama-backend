import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import type { AuthResponseDto } from './../src/auth/auth.types';
import { GOOGLE_IDENTITY_VERIFIER } from './../src/auth/identity/google/google-identity.types';
import type {
  GoogleIdentityVerifier,
  GoogleVerifiedIdentity,
} from './../src/auth/identity/google/google-identity.types';
import { GoogleTokenRejected } from './../src/auth/identity/google/google-id-token.util';
import { LocalFakeWhatsAppOtpProvider } from './../src/auth/identity/whatsapp/whatsapp-local-fake.provider';
import { WHATSAPP_OTP_PROVIDER } from './../src/auth/identity/whatsapp/whatsapp-otp.types';
import { AppErrorCode } from './../src/common/errors/app-error-code';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { e2eSuiteBootBudgetMs } from './../src/common/testing/e2e-boot-budget.helpers';
import {
  TEST_FIXTURE_NAMESPACE,
  TEST_FIXTURE_PHONE_PREFIX,
  fixturePhone,
} from './../src/common/testing/fixture-namespace.helpers';
import type { RootConfig } from './../src/config/configuration';
import { PrismaService } from './../src/prisma/prisma.service';
import { findRedemptionOffer } from './../src/rewards/rewards.constants';
import type {
  ActivePerksDto,
  MissionClaimResponseDto,
  MissionOpenResponseDto,
  PerkConsumeResponseDto,
  RedeemResponseDto,
  RewardsSnapshotDto,
} from './../src/rewards/rewards.types';

/**
 * RED PANDA V1 INTEGRATION SEAM — WhatsApp Login × Rewards.
 *
 * WHAT THIS SUITE IS FOR, AND WHAT IT DELIBERATELY IS NOT.
 * `feat/v1-whatsapp-auth` and `feat/v1-rewards-social` were developed against
 * the same base and never against each other. Each is thoroughly covered on
 * its own — `auth-identities.e2e-spec.ts` owns the OTP contract,
 * `rewards.e2e-spec.ts` owns the earn-and-spend contract, and neither is
 * repeated here. What NOTHING covered before the merge is the SEAM: whether
 * an account that exists only because someone verified a phone number is a
 * first-class citizen of the rewards economy.
 *
 * IT IS A REAL QUESTION, not a formality. A WhatsApp-created user has NO
 * email and NO password row; every rewards route resolves its wallet from
 * `AuthenticatedUser.id` alone, and a ledger key derived from anything
 * email-shaped would work perfectly for every test in `rewards.e2e-spec.ts`
 * (which registers with email and password) and fail only for the users V1
 * actually expects to have. That is the class of defect this file exists to
 * catch, and it is invisible to either branch's own suite.
 *
 * SCOPE DISCIPLINE: cross-provider facts only. Single-feature behaviour that
 * already has an owner — OTP cooldowns, resend limits, redemption
 * idempotency, ledger reconciliation — is not re-asserted here.
 *
 * NO REAL WHATSAPP MESSAGE IS SENT, AND NO REQUEST REACHES META OR GOOGLE.
 * Both providers are replaced at production's own DI seams, exactly as the
 * two feature suites do it.
 */
interface ErrorResponseBody {
  statusCode: number;
  code: string;
  message: string;
}

const INSTAGRAM_URL = 'https://www.instagram.com/redpanda';
const TIKTOK_URL = 'https://www.tiktok.com/@redpanda';
const YOUTUBE_URL = 'https://www.youtube.com/@redpanda';

const INSTAGRAM_MISSION_ID = 'task_social_instagram';
const TIKTOK_MISSION_ID = 'task_social_tiktok';
const YOUTUBE_MISSION_ID = 'task_social_youtube';
const SKIP_OFFER_ID = 'redeem_skip_next_ad';

class ScriptedGoogleVerifier implements GoogleIdentityVerifier {
  private readonly identities = new Map<string, GoogleVerifiedIdentity>();

  grant(token: string, identity: GoogleVerifiedIdentity): void {
    this.identities.set(token, identity);
  }

  verifyIdToken(idToken: string): Promise<GoogleVerifiedIdentity> {
    const identity = this.identities.get(idToken);
    return identity
      ? Promise.resolve(identity)
      : Promise.reject(new GoogleTokenRejected('bad_signature'));
  }
}

describe('V1 integration — WhatsApp Login × Rewards (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let google: ScriptedGoogleVerifier;
  let otpProvider: LocalFakeWhatsAppOtpProvider;

  /** The WhatsApp-created account: a phone number and nothing else. */
  let waToken: string;
  let waUserId: string;
  /** The Google-created account, used as the "other owner" throughout. */
  let googleToken: string;
  let googleUserId: string;

  const server = () => app.getHttpServer();

  beforeAll(async () => {
    // Read once at module construction, so these must be set before the app
    // is built — the same ordering constraint `rewards.e2e-spec.ts`
    // documents.
    process.env.REWARDS_ENABLED = 'true';
    process.env.REWARDS_SOCIAL_INSTAGRAM_URL = INSTAGRAM_URL;
    process.env.REWARDS_SOCIAL_TIKTOK_URL = TIKTOK_URL;
    process.env.REWARDS_SOCIAL_YOUTUBE_URL = YOUTUBE_URL;
    delete process.env.REWARDS_SOCIAL_FACEBOOK_URL;
    delete process.env.DEV_TOOLS_ENABLED;

    google = new ScriptedGoogleVerifier();
    // Constructed with an explicit 'test': the class refuses to exist outside
    // development/test, and passing anything else here throws.
    otpProvider = new LocalFakeWhatsAppOtpProvider('test');

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(GOOGLE_IDENTITY_VERIFIER)
      .useValue(google)
      .overrideProvider(WHATSAPP_OTP_PROVIDER)
      .useValue(otpProvider)
      .compile();

    app = moduleFixture.createNestApplication<INestApplication<App>>();
    app.useGlobalFilters(new AppExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);

    // The identity flags ship OFF, so a boot from real config would answer
    // 503 to every /auth/whatsapp/* route. Flipped on the resolved config the
    // app already holds rather than by stubbing ConfigService wholesale,
    // which would bypass the wiring this suite exists to exercise.
    const identityConfig = moduleFixture
      .get<ConfigService<RootConfig>>(ConfigService)
      .get('identityProviders', { infer: true })!;
    identityConfig.googleEnabled = true;
    identityConfig.whatsappEnabled = true;

    ({ accessToken: waToken, userId: waUserId } =
      await signInWithWhatsApp('owner'));
    ({ accessToken: googleToken, userId: googleUserId } =
      await signInWithGoogle('other'));
  }, e2eSuiteBootBudgetMs(1));

  afterAll(async () => {
    const fixtureOwners = await prisma.authIdentity.findMany({
      where: {
        OR: [
          { providerSubject: { startsWith: TEST_FIXTURE_PHONE_PREFIX } },
          { providerSubject: { startsWith: TEST_FIXTURE_NAMESPACE } },
        ],
      },
      select: { userId: true },
    });
    const ownerIds = fixtureOwners.map((row) => row.userId);

    await prisma.authAuditEvent.deleteMany({
      where: { userId: { in: ownerIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: ownerIds } } });
    await prisma.phoneOtpChallenge.deleteMany({
      where: { phoneE164: { startsWith: TEST_FIXTURE_PHONE_PREFIX } },
    });

    await app.close();

    delete process.env.REWARDS_ENABLED;
    delete process.env.REWARDS_SOCIAL_INSTAGRAM_URL;
    delete process.env.REWARDS_SOCIAL_TIKTOK_URL;
    delete process.env.REWARDS_SOCIAL_YOUTUBE_URL;
  });

  /** A full OTP round trip: an account whose only identifier is a phone. */
  async function signInWithWhatsApp(
    label: string,
  ): Promise<{ accessToken: string; userId: string }> {
    const phone = fixturePhone();

    await request(server())
      .post('/auth/whatsapp/otp/request')
      .send({ phone })
      .expect(HttpStatus.ACCEPTED);

    const code = otpProvider.lastCodeFor(phone);
    if (!code) {
      throw new Error(`fake provider recorded no code for ${label}`);
    }

    const response = await request(server())
      .post('/auth/whatsapp/otp/verify')
      .send({ phone, code })
      .expect(HttpStatus.OK);

    const body = response.body as AuthResponseDto;
    return { accessToken: body.accessToken, userId: body.user.id };
  }

  async function signInWithGoogle(
    label: string,
  ): Promise<{ accessToken: string; userId: string }> {
    const token = `${TEST_FIXTURE_NAMESPACE}-tok-${label}`;
    google.grant(token, { subject: `${TEST_FIXTURE_NAMESPACE}-g-${label}` });

    const response = await request(server())
      .post('/auth/google')
      .send({ idToken: token })
      .expect(HttpStatus.OK);

    const body = response.body as AuthResponseDto;
    return { accessToken: body.accessToken, userId: body.user.id };
  }

  const bearer = (token: string) => `Bearer ${token}`;

  /**
   * Open a social mission and make it claimable.
   *
   * The route enforces `SOCIAL_MISSION_MIN_DWELL_SECONDS`. The RECORDED open
   * is back-dated rather than slept through, exactly as
   * `rewards.e2e-spec.ts` does it: the rule under test here is cross-account
   * ownership, not the passage of wall-clock time, and this suite has no
   * business spending five real seconds per mission to observe it.
   */
  async function openAndMakeClaimable(
    missionId: string,
    token: string,
    userId: string,
  ): Promise<MissionOpenResponseDto> {
    const opened = await request(server())
      .post(`/rewards/missions/${missionId}/open`)
      .set('Authorization', bearer(token))
      .expect(HttpStatus.OK);

    await prisma.rewardMissionClaim.updateMany({
      where: { userId, missionId },
      data: { openedAt: new Date(Date.now() - 60_000) },
    });

    return opened.body as MissionOpenResponseDto;
  }

  describe('a WhatsApp-created account is a first-class rewards citizen', () => {
    it('CRITICAL: has no email at all, and still resolves its own wallet', async () => {
      // The premise. If this row ever grows an email, the rest of this
      // describe stops testing what it claims to test.
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: waUserId },
        select: { email: true, passwordHash: true },
      });
      expect(user.email).toBeNull();
      expect(user.passwordHash).toBeNull();

      const snapshot = await request(server())
        .get('/rewards/snapshot')
        .set('Authorization', bearer(waToken))
        .expect(HttpStatus.OK);

      const body = snapshot.body as RewardsSnapshotDto;
      expect(body.wallet.balancePoints).toEqual(expect.any(Number));
      // Its own wallet, not the Google account's.
      expect(JSON.stringify(body)).not.toContain(googleUserId);
    });

    it('earns from the daily check-in like any other account', async () => {
      const first = await request(server())
        .post('/rewards/check-in')
        .set('Authorization', bearer(waToken))
        .expect(HttpStatus.OK);

      expect(
        (first.body as { wallet: { balancePoints: number } }).wallet
          .balancePoints,
      ).toBeGreaterThan(0);
    });

    it('CRITICAL: opens and claims a social mission, once and only once', async () => {
      const opened = await openAndMakeClaimable(
        INSTAGRAM_MISSION_ID,
        waToken,
        waUserId,
      );

      expect(opened.destinationUrl).toBe(INSTAGRAM_URL);
      expect(opened.claimableAfter > opened.openedAt).toBe(true);

      const claimed = await request(server())
        .post(`/rewards/missions/${INSTAGRAM_MISSION_ID}/claim`)
        .set('Authorization', bearer(waToken))
        .expect(HttpStatus.OK);

      const receipt = claimed.body as MissionClaimResponseDto;
      expect(receipt.awardedPoints).toBeGreaterThan(0);
      // The honest semantics survive the merge: nothing here claims a
      // verified follow.
      expect(JSON.stringify(receipt)).not.toMatch(/VERIFIED_FOLLOW/);

      // A SECOND CLAIM PAYS NOTHING. The once-per-account ledger key is the
      // only thing bounding the cost of a mission no platform can verify, so
      // it is asserted for a phone-only account specifically — an account
      // shape the rewards suite never produces.
      const replay = await request(server())
        .post(`/rewards/missions/${INSTAGRAM_MISSION_ID}/claim`)
        .set('Authorization', bearer(waToken))
        .expect(HttpStatus.OK);

      const replayed = replay.body as MissionClaimResponseDto;
      expect(replayed.alreadyClaimed).toBe(true);
      expect(replayed.awardedPoints).toBe(0);
      // The ORIGINAL receipt, not a second one: a replay must point at the
      // ledger entry that already exists rather than appending another.
      expect(replayed.ledgerEntryId).toBe(receipt.ledgerEntryId);
      // The balance is the one the first claim left behind.
      expect(replayed.wallet.balancePoints).toBe(receipt.wallet.balancePoints);
    });

    it('CRITICAL: one account claiming a mission does not claim it for another', async () => {
      // The ledger key is per-account, so the Google user's Instagram mission
      // must still be open after the WhatsApp user claimed theirs. A key
      // derived from the MISSION alone would pass every single-account test
      // and quietly pay the first caller only.
      const opened = await openAndMakeClaimable(
        INSTAGRAM_MISSION_ID,
        googleToken,
        googleUserId,
      );

      expect(opened.destinationUrl).toBe(INSTAGRAM_URL);

      const claimed = await request(server())
        .post(`/rewards/missions/${INSTAGRAM_MISSION_ID}/claim`)
        .set('Authorization', bearer(googleToken))
        .expect(HttpStatus.OK);

      expect(
        (claimed.body as MissionClaimResponseDto).awardedPoints,
      ).toBeGreaterThan(0);
    });
  });

  describe('a Google-created account is unaffected by the WhatsApp merge', () => {
    it('reads its own snapshot and checks in normally', async () => {
      const snapshot = await request(server())
        .get('/rewards/snapshot')
        .set('Authorization', bearer(googleToken))
        .expect(HttpStatus.OK);

      expect(
        (snapshot.body as RewardsSnapshotDto).wallet.balancePoints,
      ).toEqual(expect.any(Number));

      await request(server())
        .post('/rewards/check-in')
        .set('Authorization', bearer(googleToken))
        .expect(HttpStatus.OK);
    });
  });

  describe('an ad perk belongs to exactly one authenticated owner', () => {
    it('CRITICAL: a perk bought by the WhatsApp user is invisible and unspendable to the Google user', async () => {
      const offer = findRedemptionOffer(SKIP_OFFER_ID)!;

      // Earn enough to afford it WITHOUT the dev grant route, which is
      // unreachable here (DEV_TOOLS_ENABLED is deliberately unset) — so this
      // account reaches 150 points the way a real user would.
      //
      // The account already holds the day-1 check-in (10) and the Instagram
      // mission (50) from the tests above; TikTok and YouTube bring it to
      // 160, clearing the 150-point offer with the smallest honest margin.
      for (const missionId of [TIKTOK_MISSION_ID, YOUTUBE_MISSION_ID]) {
        await openAndMakeClaimable(missionId, waToken, waUserId);
        await request(server())
          .post(`/rewards/missions/${missionId}/claim`)
          .set('Authorization', bearer(waToken))
          .expect(HttpStatus.OK);
      }

      const snapshot = await request(server())
        .get('/rewards/snapshot')
        .set('Authorization', bearer(waToken))
        .expect(HttpStatus.OK);

      if (
        (snapshot.body as RewardsSnapshotDto).wallet.balancePoints <
        offer.costPoints
      ) {
        // Not a silent skip: state why, so a curve change that starves this
        // test is visible in the run rather than passing vacuously.
        throw new Error(
          `WhatsApp account cannot afford ${SKIP_OFFER_ID} (${offer.costPoints} points) ` +
            'from check-in + two social missions; adjust the fixture, not the assertion.',
        );
      }

      const redeemed = await request(server())
        .post('/rewards/redemptions')
        .set('Authorization', bearer(waToken))
        .send({ offerId: SKIP_OFFER_ID, idempotencyKey: 'v1-seam-perk-0001' })
        .expect(HttpStatus.OK);

      const perk = (redeemed.body as RedeemResponseDto).perk;
      expect(perk).not.toBeNull();

      // The owner sees it.
      const ownerPerks = await request(server())
        .get('/rewards/perks')
        .set('Authorization', bearer(waToken))
        .expect(HttpStatus.OK);
      expect((ownerPerks.body as ActivePerksDto).skipNextInterstitial).toBe(
        true,
      );

      // The other account does not — across a DIFFERENT sign-in provider,
      // which is the fact this suite adds over `rewards.e2e-spec.ts`.
      const otherPerks = await request(server())
        .get('/rewards/perks')
        .set('Authorization', bearer(googleToken))
        .expect(HttpStatus.OK);
      expect((otherPerks.body as ActivePerksDto).skipNextInterstitial).toBe(
        false,
      );

      // ...and cannot spend it. 404, never 403: the lookup is scoped to the
      // caller, so this can never be used to probe whether someone else
      // holds a perk.
      const stolen = await request(server())
        .post(`/rewards/perks/${perk!.id}/consume`)
        .set('Authorization', bearer(googleToken))
        .expect(HttpStatus.NOT_FOUND);

      expect((stolen.body as ErrorResponseBody).code).toBe(
        AppErrorCode.REWARD_PERK_NOT_FOUND,
      );

      // The owner still can, and the perk is still there to spend.
      const consumed = await request(server())
        .post(`/rewards/perks/${perk!.id}/consume`)
        .set('Authorization', bearer(waToken))
        .expect(HttpStatus.OK);

      expect((consumed.body as PerkConsumeResponseDto).consumed).toBe(true);
    });
  });

  describe('the two features answer with distinct, unmixed error codes', () => {
    it('CRITICAL: a rewards failure never answers with a WhatsApp code, or vice versa', async () => {
      const missionMiss = await request(server())
        .post('/rewards/missions/task_social_not_a_real_mission/claim')
        .set('Authorization', bearer(waToken))
        .expect(HttpStatus.NOT_FOUND);

      expect((missionMiss.body as ErrorResponseBody).code).toBe(
        AppErrorCode.REWARD_MISSION_NOT_FOUND,
      );
      expect((missionMiss.body as ErrorResponseBody).code).not.toMatch(
        /^WHATSAPP_/,
      );

      const otpBadShape = await request(server())
        .post('/auth/whatsapp/otp/request')
        .send({ phone: 'not-a-phone-number' })
        .expect(HttpStatus.BAD_REQUEST);

      expect((otpBadShape.body as ErrorResponseBody).code).not.toMatch(
        /^REWARD_/,
      );
    });

    it('rejects both feature surfaces without a credential, before any feature logic', async () => {
      const authenticatedRoutes: ['get' | 'post', string][] = [
        ['get', '/rewards/snapshot'],
        ['get', '/rewards/perks'],
        ['post', `/rewards/missions/${INSTAGRAM_MISSION_ID}/claim`],
        ['get', '/auth/identities'],
      ];

      for (const [method, route] of authenticatedRoutes) {
        await request(server())[method](route).expect(HttpStatus.UNAUTHORIZED);
      }
    });
  });
});
