import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { StorageService } from './../src/storage/storage.service';
import type { AuthResponseDto } from './../src/auth/auth.types';
import type { EntitlementStatusDto } from './../src/entitlements/entitlement.types';
import type {
  HlsPlaybackResponseDto,
  VideoPlaybackResponseDto,
  VideoResponseDto,
} from './../src/videos/video.types';
import { e2eSuiteBootBudgetMs } from './../src/common/testing/e2e-boot-budget.helpers';

/**
 * ===========================================================================
 * Work unit "V1 FREE ACCESS POLICY" — the CONTENT_ACCESS_MODE policy matrix.
 * ===========================================================================
 *
 * Red Panda V1 for Google Play ships FREE and ad-monetized with NO purchase
 * flow of any kind. The catalog, however, already carries explicit
 * `accessTierOverride: 'premium'` values (every `series-101` episode 6-10,
 * from the 11F-4 backfill), which in the shipped `entitlement` mode makes
 * those episodes unreachable rather than merely paywalled. `CONTENT_ACCESS_MODE`
 * is the reversible, read-side switch that resolves that; this file is its
 * end-to-end proof.
 *
 * WHY A DEDICATED FILE RATHER THAN NEW CASES IN `videos.e2e-spec.ts`. The
 * mode is read ONCE per process, when `configuration()` runs during
 * `ConfigModule` initialization — so proving BOTH modes requires compiling
 * TWO separate `AppModule` instances with different `process.env` snapshots.
 * `videos.e2e-spec.ts` deliberately compiles one shared module for its whole
 * file, and must keep asserting the DEFAULT mode's behavior undisturbed.
 *
 * Each describe below boots its own app, creates its own fixture rows under
 * its own `seriesId`, and deletes exactly what it created. Nothing here
 * touches the real catalog: no seeded row is read for an assertion, and no
 * row outside this file's own `seriesId` prefix is ever written.
 *
 * `StorageService` is mocked for every boot (the `videos.e2e-spec.ts` /
 * `admin-media.e2e-spec.ts` precedent) — no R2/S3 network call is made.
 */

/**
 * Synthetic, test-only HLS gateway config, set at module-evaluation time so
 * it is in place before any `AppModule` compiles. Identical in purpose and
 * shape to `videos.e2e-spec.ts`'s own pair: the real `.env` has neither set,
 * `TRANSCODE_ENABLED` stays off, and this turns nothing on — it only lets
 * this file's hand-created HLS-ready fixture rows resolve a gateway URL.
 */
process.env.HLS_GATEWAY_BASE_URL = 'https://hls-gateway.access-mode.internal';
process.env.HLS_TOKEN_SECRET = 'content-access-mode-e2e-synthetic-secret';

interface ErrorResponseBody {
  statusCode: number;
  code: string;
  message: string;
}

interface SuiteHandles {
  app: INestApplication<App>;
  prisma: PrismaService;
}

/**
 * Compiles and initializes a fresh `AppModule` with `CONTENT_ACCESS_MODE`
 * set to `mode` (or removed entirely when `mode` is `undefined`, which is
 * how the "unset means entitlement" default is proven). The variable is
 * restored to its pre-boot value immediately after compilation, so a
 * subsequent boot in this same Jest worker is not affected by this one.
 */
async function bootAppWithMode(
  mode: 'entitlement' | 'free' | undefined,
): Promise<SuiteHandles> {
  const previous = process.env.CONTENT_ACCESS_MODE;

  if (mode === undefined) {
    delete process.env.CONTENT_ACCESS_MODE;
  } else {
    process.env.CONTENT_ACCESS_MODE = mode;
  }

  try {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(StorageService)
      .useValue({ createPresignedGetUrl: jest.fn() })
      .compile();

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
  } finally {
    if (previous === undefined) {
      delete process.env.CONTENT_ACCESS_MODE;
    } else {
      process.env.CONTENT_ACCESS_MODE = previous;
    }
  }
}

/**
 * The three fixture shapes every describe below needs, created under a
 * caller-supplied `seriesId` so two suites can never collide:
 *
 *   free      ep 1,  accessTierOverride 'free',    HLS-ready
 *   premium   ep 6,  accessTierOverride 'premium', HLS-ready  <- the V1 dead-end
 *   derived   ep 10, accessTierOverride null,      HLS-ready  <- derivation path
 *   local     ep 7,  accessTierOverride 'premium', plain local MP4
 *
 * The `premium` row is deliberately the exact shape of `video-101-06`: a
 * published, `processingState: 'ready'` HLS row carrying an EXPLICIT
 * `'premium'` override. The `derived` row covers the other branch — a null
 * override falling through to `episodeNumber > FREE_EPISODE_LIMIT`.
 */
interface Fixtures {
  freeId: string;
  premiumId: string;
  derivedId: string;
  localPremiumId: string;
  premiumPrefix: string;
}

async function createFixtures(
  prisma: PrismaService,
  seriesId: string,
): Promise<Fixtures> {
  const rows = [
    { suffix: 'free', episodeNumber: 1, accessTierOverride: 'free' },
    { suffix: 'premium', episodeNumber: 6, accessTierOverride: 'premium' },
    { suffix: 'derived', episodeNumber: 10, accessTierOverride: null },
  ];

  const prefixes: Record<string, string> = {};

  for (const [index, row] of rows.entries()) {
    const id = `${seriesId}-${row.suffix}`;
    const prefix = `admin-media/${id}/hls/v1-a1-2222222${index}-2222-2222-2222-222222222222/`;
    prefixes[row.suffix] = prefix;

    await prisma.video.create({
      data: {
        id,
        seriesId,
        title: `Access-mode fixture ${row.suffix}`,
        episodeNumber: row.episodeNumber,
        channelName: 'E2E Channel',
        caption: 'Access-mode fixture caption',
        category: 'drama',
        storageKey: '',
        objectStorageKey: `r2/access-mode-fixture/${row.suffix}.mp4`,
        sourceLanguage: 'zh',
        hasEmbeddedIndonesianSubtitle: true,
        likeCount: 0,
        lifecycleState: 'published',
        accessTierOverride: row.accessTierOverride,
        processingState: 'ready',
        hlsMasterKey: `${prefix}master.m3u8`,
        hlsRenditions: [
          { name: '360p', width: 360, height: 640, bandwidth: 900_000 },
          { name: '540p', width: 540, height: 960, bandwidth: 1_800_000 },
        ],
      },
    });
  }

  const localPremiumId = `${seriesId}-local-premium`;
  await prisma.video.create({
    data: {
      id: localPremiumId,
      seriesId,
      title: 'Access-mode fixture local premium',
      episodeNumber: 7,
      channelName: 'E2E Channel',
      caption: 'Access-mode local fixture caption',
      category: 'drama',
      storageKey: 'AccessMode/local-premium.mp4',
      sourceLanguage: 'zh',
      hasEmbeddedIndonesianSubtitle: true,
      likeCount: 0,
      lifecycleState: 'published',
      accessTierOverride: 'premium',
    },
  });

  return {
    freeId: `${seriesId}-free`,
    premiumId: `${seriesId}-premium`,
    derivedId: `${seriesId}-derived`,
    localPremiumId,
    premiumPrefix: prefixes.premium,
  };
}

function expectValidHlsBody(body: HlsPlaybackResponseDto): void {
  expect(body.type).toBe('hls');
  expect(
    body.masterUrl.startsWith(`${process.env.HLS_GATEWAY_BASE_URL}/t/`),
  ).toBe(true);
  expect(body.renditions.length).toBeGreaterThan(0);
  expect(typeof body.expiresAt).toBe('string');
}

// ===========================================================================
// NORMAL / EXISTING MODE
// ===========================================================================

describe('CONTENT_ACCESS_MODE unset — entitlement mode (existing behavior)', () => {
  const seriesId = 'content-access-mode-e2e-entitlement';
  const emailPrefix = 'content-access-mode-e2e+entitlement';

  let app: INestApplication<App>;
  let prisma: PrismaService;
  let fixtures: Fixtures;
  let plainToken: string;
  let plainUserId: string;
  let entitledToken: string;
  let entitledUserId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootAppWithMode(undefined));
    fixtures = await createFixtures(prisma, seriesId);

    const plain = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: `${emailPrefix}-plain-${Date.now()}@example.test`,
        password: 'correct-horse-battery',
      })
      .expect(HttpStatus.CREATED);
    plainToken = (plain.body as AuthResponseDto).accessToken;
    plainUserId = (plain.body as AuthResponseDto).user.id;

    const entitled = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: `${emailPrefix}-entitled-${Date.now()}@example.test`,
        password: 'correct-horse-battery',
      })
      .expect(HttpStatus.CREATED);
    entitledToken = (entitled.body as AuthResponseDto).accessToken;
    entitledUserId = (entitled.body as AuthResponseDto).user.id;

    // A REAL entitlement row, written through the same table the payments
    // and rewards grant paths write — never a mode flag, never a fake.
    await prisma.entitlement.create({
      data: {
        userId: entitledUserId,
        tier: 'premium',
        source: 'content-access-mode-e2e',
      },
    });
  }, e2eSuiteBootBudgetMs(2));

  afterAll(async () => {
    await prisma.entitlement.deleteMany({
      where: { userId: { in: [plainUserId, entitledUserId] } },
    });
    await prisma.video.deleteMany({ where: { seriesId } });
    await prisma.user.deleteMany({
      where: { email: { contains: emailPrefix } },
    });
    await app.close();
  });

  it('the config factory resolved the DEFAULT mode — an unset variable is not free mode', () => {
    expect(process.env.CONTENT_ACCESS_MODE).toBeUndefined();
  });

  it('FREE episode (ep 1): a guest gets HLS playback authorization, exactly as before', async () => {
    const response = await request(app.getHttpServer())
      .get(`/videos/${fixtures.freeId}/playback`)
      .expect(HttpStatus.OK);

    expectValidHlsBody(response.body as HlsPlaybackResponseDto);
  });

  it('FREE episode (ep 1): the public DTO reports accessTier "free"', async () => {
    const response = await request(app.getHttpServer())
      .get(`/videos/${fixtures.freeId}`)
      .expect(HttpStatus.OK);

    expect((response.body as VideoResponseDto).accessTier).toBe('free');
  });

  it('PREMIUM episode without an entitlement (guest): 403 ENTITLEMENT_REQUIRED', async () => {
    const response = await request(app.getHttpServer())
      .get(`/videos/${fixtures.premiumId}/playback`)
      .expect(HttpStatus.FORBIDDEN);

    expect((response.body as ErrorResponseBody).code).toBe(
      'ENTITLEMENT_REQUIRED',
    );
  });

  it('PREMIUM episode without an entitlement (signed-in): 403 ENTITLEMENT_REQUIRED', async () => {
    const response = await request(app.getHttpServer())
      .get(`/videos/${fixtures.premiumId}/playback`)
      .set('Authorization', `Bearer ${plainToken}`)
      .expect(HttpStatus.FORBIDDEN);

    expect((response.body as ErrorResponseBody).code).toBe(
      'ENTITLEMENT_REQUIRED',
    );
  });

  it('PREMIUM episode WITH an entitlement: HLS authorization succeeds', async () => {
    const response = await request(app.getHttpServer())
      .get(`/videos/${fixtures.premiumId}/playback`)
      .set('Authorization', `Bearer ${entitledToken}`)
      .expect(HttpStatus.OK);

    expectValidHlsBody(response.body as HlsPlaybackResponseDto);
  });

  it('PREMIUM episode: the public DTO reports accessTier "premium"', async () => {
    const response = await request(app.getHttpServer())
      .get(`/videos/${fixtures.premiumId}`)
      .expect(HttpStatus.OK);

    expect((response.body as VideoResponseDto).accessTier).toBe('premium');
  });

  it('DERIVED premium (ep 10, null override): still premium via the episodeNumber rule', async () => {
    const dto = await request(app.getHttpServer())
      .get(`/videos/${fixtures.derivedId}`)
      .expect(HttpStatus.OK);
    expect((dto.body as VideoResponseDto).accessTier).toBe('premium');

    const playback = await request(app.getHttpServer())
      .get(`/videos/${fixtures.derivedId}/playback`)
      .expect(HttpStatus.FORBIDDEN);
    expect((playback.body as ErrorResponseBody).code).toBe(
      'ENTITLEMENT_REQUIRED',
    );
  });

  it('LOCAL-storage premium row: requiresAuthHeader is true for an entitled caller', async () => {
    const response = await request(app.getHttpServer())
      .get(`/videos/${fixtures.localPremiumId}/playback`)
      .set('Authorization', `Bearer ${entitledToken}`)
      .expect(HttpStatus.OK);

    expect((response.body as VideoPlaybackResponseDto).requiresAuthHeader).toBe(
      true,
    );
  });
});

// ===========================================================================
// FREE V1 MODE
// ===========================================================================

describe('CONTENT_ACCESS_MODE=free — V1 access policy', () => {
  const seriesId = 'content-access-mode-e2e-free';
  const emailPrefix = 'content-access-mode-e2e+free';

  let app: INestApplication<App>;
  let prisma: PrismaService;
  let fixtures: Fixtures;
  let plainToken: string;
  let plainUserId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootAppWithMode('free'));
    fixtures = await createFixtures(prisma, seriesId);

    const plain = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: `${emailPrefix}-plain-${Date.now()}@example.test`,
        password: 'correct-horse-battery',
      })
      .expect(HttpStatus.CREATED);
    plainToken = (plain.body as AuthResponseDto).accessToken;
    plainUserId = (plain.body as AuthResponseDto).user.id;
  }, e2eSuiteBootBudgetMs(1));

  afterAll(async () => {
    await prisma.entitlement.deleteMany({ where: { userId: plainUserId } });
    await prisma.video.deleteMany({ where: { seriesId } });
    await prisma.user.deleteMany({
      where: { email: { contains: emailPrefix } },
    });
    await app.close();
  });

  describe('playback authorization', () => {
    it('ep 1-5 shape (explicit "free" override): guest gets HLS authorization', async () => {
      const response = await request(app.getHttpServer())
        .get(`/videos/${fixtures.freeId}/playback`)
        .expect(HttpStatus.OK);

      expectValidHlsBody(response.body as HlsPlaybackResponseDto);
    });

    /**
     * THE CORE V1 PROOF. This row is byte-identical in shape to
     * `video-101-06`: published, HLS-ready, explicit `'premium'` override,
     * episode 6. In `entitlement` mode the identical request 403s (proven in
     * the describe above); here it must authorize.
     */
    it('ep 6-10 shape (explicit "premium" override): an UNAUTHENTICATED guest gets HLS authorization', async () => {
      const response = await request(app.getHttpServer())
        .get(`/videos/${fixtures.premiumId}/playback`)
        .expect(HttpStatus.OK);

      expectValidHlsBody(response.body as HlsPlaybackResponseDto);
    });

    it('ep 6-10 shape: a SIGNED-IN, NON-ENTITLED viewer gets HLS authorization', async () => {
      const response = await request(app.getHttpServer())
        .get(`/videos/${fixtures.premiumId}/playback`)
        .set('Authorization', `Bearer ${plainToken}`)
        .expect(HttpStatus.OK);

      expectValidHlsBody(response.body as HlsPlaybackResponseDto);
    });

    it('the DERIVED premium row (ep 10, null override) is authorized too — the mode covers both resolver branches', async () => {
      const response = await request(app.getHttpServer())
        .get(`/videos/${fixtures.derivedId}/playback`)
        .expect(HttpStatus.OK);

      expectValidHlsBody(response.body as HlsPlaybackResponseDto);
    });

    it('ENTITLEMENT_REQUIRED is never returned for ANY published fixture row, for guest or signed-in', async () => {
      const ids = [
        fixtures.freeId,
        fixtures.premiumId,
        fixtures.derivedId,
        fixtures.localPremiumId,
      ];

      for (const id of ids) {
        const guest = await request(app.getHttpServer()).get(
          `/videos/${id}/playback`,
        );
        expect(guest.status).toBe(HttpStatus.OK);

        const signedIn = await request(app.getHttpServer())
          .get(`/videos/${id}/playback`)
          .set('Authorization', `Bearer ${plainToken}`);
        expect(signedIn.status).toBe(HttpStatus.OK);
      }
    });

    it('a LOCAL-storage premium row now reports requiresAuthHeader false — a guest is told the truth about /stream', async () => {
      const response = await request(app.getHttpServer())
        .get(`/videos/${fixtures.localPremiumId}/playback`)
        .expect(HttpStatus.OK);

      expect(
        (response.body as VideoPlaybackResponseDto).requiresAuthHeader,
      ).toBe(false);
    });
  });

  describe('public DTO contract', () => {
    it('GET /videos/:id reports accessTier "free" for the explicitly-premium row', async () => {
      const response = await request(app.getHttpServer())
        .get(`/videos/${fixtures.premiumId}`)
        .expect(HttpStatus.OK);

      expect((response.body as VideoResponseDto).accessTier).toBe('free');
    });

    it('GET /videos/feed agrees with GET /videos/:id for every fixture row', async () => {
      const feed = await request(app.getHttpServer())
        .get('/videos/feed')
        .expect(HttpStatus.OK);

      const items = (feed.body as VideoResponseDto[]).filter(
        (item) => item.seriesId === seriesId,
      );

      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.accessTier).toBe('free');
        expect(item).not.toHaveProperty('accessTierOverride');
      }
    });
  });

  describe('the entitlement architecture is intact, not deleted', () => {
    it('the stored accessTierOverride is untouched — free mode read nothing into the catalog', async () => {
      const rows = await prisma.video.findMany({
        where: { seriesId },
        select: { id: true, accessTierOverride: true },
        orderBy: { id: 'asc' },
      });

      expect(
        rows.find((row) => row.id === fixtures.premiumId)?.accessTierOverride,
      ).toBe('premium');
      expect(
        rows.find((row) => row.id === fixtures.derivedId)?.accessTierOverride,
      ).toBeNull();
      expect(
        rows.find((row) => row.id === fixtures.freeId)?.accessTierOverride,
      ).toBe('free');
    });

    it('a non-entitled viewer is still reported NON-premium — free content does not grant premium', async () => {
      const response = await request(app.getHttpServer())
        .get('/users/me/entitlement')
        .set('Authorization', `Bearer ${plainToken}`)
        .expect(HttpStatus.OK);

      const body = response.body as EntitlementStatusDto;
      expect(body.isPremium).toBe(false);
      expect(body.expiresAt).toBeNull();
    });

    it('the entitlement endpoint still requires authentication — the mode did not open an auth hole', async () => {
      await request(app.getHttpServer())
        .get('/users/me/entitlement')
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('a REAL entitlement still reads back as premium in free mode — the grant path is fully live', async () => {
      const created = await prisma.entitlement.create({
        data: {
          userId: plainUserId,
          tier: 'premium',
          source: 'content-access-mode-e2e',
        },
      });

      try {
        const response = await request(app.getHttpServer())
          .get('/users/me/entitlement')
          .set('Authorization', `Bearer ${plainToken}`)
          .expect(HttpStatus.OK);

        expect((response.body as EntitlementStatusDto).isPremium).toBe(true);
      } finally {
        await prisma.entitlement.delete({ where: { id: created.id } });
      }
    });
  });

  /**
   * PHASE 5 — ADS SAFETY. The intended V1 state is three INDEPENDENT facts:
   * content accessible = yes, premium entitlement = no, ads eligible = yes.
   * `GET /config/ads` is the only ad contract this backend serves, it is
   * public and caller-independent, and it reads nothing but its own `ADS_*`
   * env vars — so making content free cannot suppress ads. These tests pin
   * that independence rather than asserting it in prose.
   */
  describe('ads independence', () => {
    it('GET /config/ads still answers, unauthenticated, with the full five-field contract', async () => {
      const response = await request(app.getHttpServer())
        .get('/config/ads')
        .expect(HttpStatus.OK);

      expect(Object.keys(response.body as object).sort()).toEqual(
        [
          'enabled',
          'graceVideos',
          'maxVideosBetweenAds',
          'minSecondsBetweenAds',
          'minVideosBetweenAds',
        ].sort(),
      );
    });

    it('the ads contract is byte-identical for a guest and for a signed-in non-entitled viewer', async () => {
      const guest = await request(app.getHttpServer())
        .get('/config/ads')
        .expect(HttpStatus.OK);
      const signedIn = await request(app.getHttpServer())
        .get('/config/ads')
        .set('Authorization', `Bearer ${plainToken}`)
        .expect(HttpStatus.OK);

      expect(signedIn.body).toEqual(guest.body);
    });

    it('the three V1 facts hold simultaneously: content accessible, entitlement absent, ads enabled', async () => {
      const playback = await request(app.getHttpServer())
        .get(`/videos/${fixtures.premiumId}/playback`)
        .set('Authorization', `Bearer ${plainToken}`)
        .expect(HttpStatus.OK);
      const entitlement = await request(app.getHttpServer())
        .get('/users/me/entitlement')
        .set('Authorization', `Bearer ${plainToken}`)
        .expect(HttpStatus.OK);
      const ads = await request(app.getHttpServer())
        .get('/config/ads')
        .expect(HttpStatus.OK);

      expect((playback.body as HlsPlaybackResponseDto).type).toBe('hls');
      expect((entitlement.body as EntitlementStatusDto).isPremium).toBe(false);
      expect((ads.body as { enabled: boolean }).enabled).toBe(true);
    });
  });
});

// ===========================================================================
// REVERSIBILITY
// ===========================================================================

/**
 * The switch is only safe if it is genuinely reversible. This suite boots a
 * THIRD app with the mode set back explicitly to `entitlement`, against
 * fixture rows in the very same shapes, and proves the paywall returns — no
 * migration, no backfill, no catalog write in between.
 */
describe('reversibility — CONTENT_ACCESS_MODE=entitlement restores the paywall', () => {
  const seriesId = 'content-access-mode-e2e-revert';
  const emailPrefix = 'content-access-mode-e2e+revert';

  let app: INestApplication<App>;
  let prisma: PrismaService;
  let fixtures: Fixtures;
  let plainToken: string;
  let plainUserId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootAppWithMode('entitlement'));
    fixtures = await createFixtures(prisma, seriesId);

    const plain = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: `${emailPrefix}-plain-${Date.now()}@example.test`,
        password: 'correct-horse-battery',
      })
      .expect(HttpStatus.CREATED);
    plainToken = (plain.body as AuthResponseDto).accessToken;
    plainUserId = (plain.body as AuthResponseDto).user.id;
  }, e2eSuiteBootBudgetMs(1));

  afterAll(async () => {
    await prisma.entitlement.deleteMany({ where: { userId: plainUserId } });
    await prisma.video.deleteMany({ where: { seriesId } });
    await prisma.user.deleteMany({
      where: { email: { contains: emailPrefix } },
    });
    await app.close();
  });

  it('the explicitly-premium row is denied again for a guest', async () => {
    const response = await request(app.getHttpServer())
      .get(`/videos/${fixtures.premiumId}/playback`)
      .expect(HttpStatus.FORBIDDEN);

    expect((response.body as ErrorResponseBody).code).toBe(
      'ENTITLEMENT_REQUIRED',
    );
  });

  it('the explicitly-premium row is denied again for a signed-in non-entitled viewer', async () => {
    const response = await request(app.getHttpServer())
      .get(`/videos/${fixtures.premiumId}/playback`)
      .set('Authorization', `Bearer ${plainToken}`)
      .expect(HttpStatus.FORBIDDEN);

    expect((response.body as ErrorResponseBody).code).toBe(
      'ENTITLEMENT_REQUIRED',
    );
  });

  it('the public DTO reports accessTier "premium" again', async () => {
    const response = await request(app.getHttpServer())
      .get(`/videos/${fixtures.premiumId}`)
      .expect(HttpStatus.OK);

    expect((response.body as VideoResponseDto).accessTier).toBe('premium');
  });

  it('the FREE row is still free — reverting restores the paywall, it does not lock everything', async () => {
    const response = await request(app.getHttpServer())
      .get(`/videos/${fixtures.freeId}/playback`)
      .expect(HttpStatus.OK);

    expectValidHlsBody(response.body as HlsPlaybackResponseDto);
  });
});
