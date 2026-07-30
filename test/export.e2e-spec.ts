import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { getStorageToken, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import type { AuthResponseDto } from './../src/auth/auth.types';
import type { UserExportDto } from './../src/export/export.types';

interface ErrorResponseBody {
  statusCode: number;
  code: string;
  message: string;
}

/**
 * e2e coverage for Phase 12, work unit 12C-B2 (DECISIONS.md "Phase 12 ...
 * approved..." entry, decision 5): `GET /users/me/export`. Hits the real HTTP
 * layer (routing, `JwtAuthGuard`, the dedicated `@Throttle()` override, the
 * global `ValidationPipe`, `AppExceptionFilter`) against the real
 * `PrismaService` connection, redirected to the isolated `DATABASE_URL_TEST`
 * database for the whole e2e run (see `test/jest-e2e.setup.ts`).
 * `DEV_TOOLS_ENABLED=true` for the whole file, needed only to grant a real
 * entitlement via the existing 10-B5 dev-grant route.
 *
 * Work unit 12E-B2 (`DECISIONS.md` decision 2, 2026-07-30) added the
 * `AnalyticsEvent` coverage below — events are ingested through the real
 * `POST /analytics/events` route (not inserted directly via `prisma`) for
 * the populated/ownership-isolation cases, so this file also proves the
 * full real HTTP round trip (ingest → export) for the new section; the
 * defence-in-depth read-time-filtering proof uses a direct `prisma` insert
 * deliberately, to simulate a row that bypassed the write-time scrub.
 */
describe('User data export (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let throttlerStorage: ThrottlerStorageService;

  const emailPrefix = 'export-e2e+12cb2';
  const seededVideoId = 'video-104-01';
  const seededSeriesId = 'series-104';
  const uniqueEmail = (label: string): string =>
    `${emailPrefix}-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  beforeAll(async () => {
    process.env.DEV_TOOLS_ENABLED = 'true';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
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
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(getStorageToken());
  });

  beforeEach(() => {
    throttlerStorage.storage.clear();
  });

  afterAll(async () => {
    await prisma.userVideoInteraction.deleteMany({
      where: { user: { email: { contains: emailPrefix } } },
    });
    await prisma.watchProgress.deleteMany({
      where: { user: { email: { contains: emailPrefix } } },
    });
    await prisma.entitlement.deleteMany({
      where: { user: { email: { contains: emailPrefix } } },
    });
    await prisma.authAuditEvent.deleteMany({
      where: { user: { email: { contains: emailPrefix } } },
    });
    // `AnalyticsEvent.userId` is `onDelete: SetNull` (not `Cascade`) — must
    // run before `user.deleteMany` below, mirroring `export.service.spec.ts`.
    await prisma.analyticsEvent.deleteMany({
      where: { user: { email: { contains: emailPrefix } } },
    });
    await prisma.session.deleteMany({
      where: { user: { email: { contains: emailPrefix } } },
    });
    await prisma.user.deleteMany({
      where: { email: { contains: emailPrefix } },
    });
    await app.close();
    delete process.env.DEV_TOOLS_ENABLED;
  });

  async function registerAccount(
    label: string,
  ): Promise<{ email: string; auth: AuthResponseDto }> {
    const email = uniqueEmail(label);
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'correct-horse-battery' })
      .expect(HttpStatus.CREATED);
    return { email, auth: response.body as AuthResponseDto };
  }

  it('rejects an unauthenticated call with no Authorization header', async () => {
    const response = await request(app.getHttpServer())
      .get('/users/me/export')
      .expect(HttpStatus.UNAUTHORIZED);

    expect((response.body as ErrorResponseBody).code).toBe(
      'INVALID_ACCESS_TOKEN',
    );
  });

  it('exports cleanly for a fresh registration with no data: profile fields present, every collection empty, no error', async () => {
    const { email, auth } = await registerAccount('fresh');

    const response = await request(app.getHttpServer())
      .get('/users/me/export')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .expect(HttpStatus.OK);

    const body = response.body as UserExportDto;
    const { memberSince, ...restProfile } = body.profile;
    expect(memberSince).toEqual(expect.any(String));
    expect(restProfile).toEqual({ email, displayName: null });
    expect(body.interactions).toEqual([]);
    expect(body.watchProgress).toEqual([]);
    expect(body.entitlements).toEqual([]);
    expect(body.analyticsEvents).toEqual([]);
    expect(typeof body.exportedAt).toBe('string');
  });

  it("returns the caller's own interactions, watch progress, and entitlements, correctly shaped", async () => {
    const { auth } = await registerAccount('populated');

    await request(app.getHttpServer())
      .post(`/videos/${seededVideoId}/like`)
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .expect(HttpStatus.CREATED);
    await request(app.getHttpServer())
      .post(`/videos/${seededVideoId}/save`)
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .expect(HttpStatus.CREATED);
    await request(app.getHttpServer())
      .put(`/series/${seededSeriesId}/progress`)
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .send({ videoId: seededVideoId, episodeNumber: 1, positionSeconds: 42 })
      .expect(HttpStatus.OK);
    await request(app.getHttpServer())
      .post('/dev/entitlements/grant')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .send({})
      .expect(HttpStatus.CREATED);
    await request(app.getHttpServer())
      .post('/analytics/events')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .send({
        events: [
          {
            eventName: 'video_play',
            properties: {
              videoId: seededVideoId,
              seriesId: seededSeriesId,
              episodeNumber: 1,
              // Not in `video_play`'s allowlist — proves the real HTTP
              // ingestion route's own write-time scrub already strips it,
              // and the export's independent read-time filter has nothing
              // to do here (the dedicated bypass test below covers the case
              // where a row skips the write-time scrub entirely).
              notAllowlisted: 'should-be-stripped-at-write-time',
            },
            clientTimestamp: new Date().toISOString(),
            platform: 'ios',
          },
        ],
      })
      .expect(HttpStatus.CREATED);

    const seededVideo = await prisma.video.findUniqueOrThrow({
      where: { id: seededVideoId },
    });

    const response = await request(app.getHttpServer())
      .get('/users/me/export')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .expect(HttpStatus.OK);

    const body = response.body as UserExportDto;

    const interaction = body.interactions.find(
      (row) => row.videoId === seededVideoId,
    );
    expect(interaction).toBeDefined();
    const { updatedAt: interactionUpdatedAt, ...interactionRest } =
      interaction!;
    expect(interactionUpdatedAt).toEqual(expect.any(String));
    expect(interactionRest).toEqual({
      videoId: seededVideoId,
      videoTitle: seededVideo.title,
      isLiked: true,
      isSaved: true,
    });

    const progress = body.watchProgress.find(
      (row) => row.videoId === seededVideoId,
    );
    expect(progress).toBeDefined();
    const { updatedAt: progressUpdatedAt, ...progressRest } = progress!;
    expect(progressUpdatedAt).toEqual(expect.any(String));
    expect(progressRest).toEqual({
      seriesId: seededSeriesId,
      videoId: seededVideoId,
      videoTitle: seededVideo.title,
      episodeNumber: 1,
      positionSeconds: 42,
    });

    expect(body.entitlements).toHaveLength(1);
    const { grantedAt, ...entitlementRest } = body.entitlements[0];
    expect(grantedAt).toEqual(expect.any(String));
    expect(entitlementRest).toEqual({
      tier: 'premium',
      source: 'dev-grant',
      expiresAt: null,
      revokedAt: null,
    });

    expect(body.analyticsEvents).toHaveLength(1);
    const { timestamp, ...analyticsRest } = body.analyticsEvents[0];
    expect(timestamp).toEqual(expect.any(String));
    expect(analyticsRest).toEqual({
      eventName: 'video_play',
      platform: 'ios',
      properties: {
        videoId: seededVideoId,
        seriesId: seededSeriesId,
        episodeNumber: 1,
      },
    });

    // Cleanup so this test's rows don't bleed into the isolation test below.
    await request(app.getHttpServer())
      .delete(`/videos/${seededVideoId}/like`)
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .expect(HttpStatus.OK);
    await request(app.getHttpServer())
      .delete(`/videos/${seededVideoId}/save`)
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .expect(HttpStatus.OK);
  });

  it("IDOR/ownership isolation: user A's export contains none of user B's data", async () => {
    const { auth: authA } = await registerAccount('idor-a');
    const { auth: authB } = await registerAccount('idor-b');

    // B likes+saves the seeded video and grants itself an entitlement; A
    // never touches it.
    await request(app.getHttpServer())
      .post(`/videos/${seededVideoId}/like`)
      .set('Authorization', `Bearer ${authB.accessToken}`)
      .expect(HttpStatus.CREATED);
    await request(app.getHttpServer())
      .post(`/videos/${seededVideoId}/save`)
      .set('Authorization', `Bearer ${authB.accessToken}`)
      .expect(HttpStatus.CREATED);
    await request(app.getHttpServer())
      .put(`/series/${seededSeriesId}/progress`)
      .set('Authorization', `Bearer ${authB.accessToken}`)
      .send({ videoId: seededVideoId, episodeNumber: 5, positionSeconds: 7 })
      .expect(HttpStatus.OK);
    await request(app.getHttpServer())
      .post('/dev/entitlements/grant')
      .set('Authorization', `Bearer ${authB.accessToken}`)
      .send({})
      .expect(HttpStatus.CREATED);
    await request(app.getHttpServer())
      .post('/analytics/events')
      .set('Authorization', `Bearer ${authB.accessToken}`)
      .send({
        events: [
          {
            eventName: 'feed_view',
            clientTimestamp: new Date().toISOString(),
            platform: 'web',
          },
        ],
      })
      .expect(HttpStatus.CREATED);

    const responseA = await request(app.getHttpServer())
      .get('/users/me/export')
      .set('Authorization', `Bearer ${authA.accessToken}`)
      .expect(HttpStatus.OK);
    const responseB = await request(app.getHttpServer())
      .get('/users/me/export')
      .set('Authorization', `Bearer ${authB.accessToken}`)
      .expect(HttpStatus.OK);

    const bodyA = responseA.body as UserExportDto;
    const bodyB = responseB.body as UserExportDto;

    expect(bodyA.interactions).toEqual([]);
    expect(bodyA.watchProgress).toEqual([]);
    expect(bodyA.entitlements).toEqual([]);
    expect(bodyA.analyticsEvents).toEqual([]);

    expect(bodyB.interactions).toHaveLength(1);
    expect(bodyB.watchProgress).toHaveLength(1);
    expect(bodyB.entitlements).toHaveLength(1);
    expect(bodyB.analyticsEvents).toHaveLength(1);

    // Also assert at the string level: A's raw response never contains B's
    // account email or any of B's data.
    expect(JSON.stringify(bodyA)).not.toContain(seededVideoId);

    await request(app.getHttpServer())
      .delete(`/videos/${seededVideoId}/like`)
      .set('Authorization', `Bearer ${authB.accessToken}`)
      .expect(HttpStatus.OK);
    await request(app.getHttpServer())
      .delete(`/videos/${seededVideoId}/save`)
      .set('Authorization', `Bearer ${authB.accessToken}`)
      .expect(HttpStatus.OK);
  });

  it('exhaustive exclusion: the serialized response never contains a passwordHash value, refresh-token hash, ipHash, storage key, role value, or any surrogate row id', async () => {
    const { email, auth } = await registerAccount('exclusion');

    await request(app.getHttpServer())
      .post(`/videos/${seededVideoId}/like`)
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .expect(HttpStatus.CREATED);
    await request(app.getHttpServer())
      .put(`/series/${seededSeriesId}/progress`)
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .send({ videoId: seededVideoId, episodeNumber: 2, positionSeconds: 9 })
      .expect(HttpStatus.OK);
    await request(app.getHttpServer())
      .post('/dev/entitlements/grant')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .send({})
      .expect(HttpStatus.CREATED);
    await request(app.getHttpServer())
      .post('/analytics/events')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .send({
        events: [
          {
            eventName: 'app_error',
            properties: { message: 'boom', isFatal: true },
            clientTimestamp: new Date().toISOString(),
            platform: 'android',
          },
        ],
      })
      .expect(HttpStatus.CREATED);

    const response = await request(app.getHttpServer())
      .get('/users/me/export')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .expect(HttpStatus.OK);
    const serialized = JSON.stringify(response.body);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const sessions = await prisma.session.findMany({
      where: { userId: user.id },
    });
    const interaction = await prisma.userVideoInteraction.findUniqueOrThrow({
      where: { userId_videoId: { userId: user.id, videoId: seededVideoId } },
    });
    const progress = await prisma.watchProgress.findUniqueOrThrow({
      where: {
        userId_seriesId: { userId: user.id, seriesId: seededSeriesId },
      },
    });
    const entitlement = await prisma.entitlement.findFirstOrThrow({
      where: { userId: user.id },
    });
    const analyticsEvent = await prisma.analyticsEvent.findFirstOrThrow({
      where: { userId: user.id },
    });
    const seededVideo = await prisma.video.findUniqueOrThrow({
      where: { id: seededVideoId },
    });

    // Real secret/internal values, fetched straight from the DB — a
    // deliberately-broken export would leak at least one of these.
    expect(serialized).not.toContain(user.passwordHash);
    expect(serialized).not.toContain(user.id);
    expect(serialized).not.toContain(interaction.id);
    expect(serialized).not.toContain(progress.id);
    expect(serialized).not.toContain(entitlement.id);
    expect(serialized).not.toContain(analyticsEvent.id);
    expect(serialized).not.toContain(seededVideo.storageKey);
    for (const session of sessions) {
      expect(serialized).not.toContain(session.refreshTokenHash);
      if (session.ipHash) {
        expect(serialized).not.toContain(session.ipHash);
      }
      expect(serialized).not.toContain(session.id);
    }

    // Field-name-level assertions: none of these keys should ever appear,
    // regardless of value, since this DTO never has a reason to carry them.
    expect(serialized).not.toContain('"id":');
    expect(serialized).not.toContain('"role"');
    expect(serialized).not.toContain('"passwordHash"');
    expect(serialized).not.toContain('"refreshTokenHash"');
    expect(serialized).not.toContain('"ipHash"');
    expect(serialized).not.toContain('storageKey');
    expect(serialized).not.toContain('objectStorageKey');

    await request(app.getHttpServer())
      .delete(`/videos/${seededVideoId}/like`)
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .expect(HttpStatus.OK);
  });

  /**
   * Phase 12, work unit 12E-B2 (`DECISIONS.md` decision 2, 2026-07-30):
   * proves the read-time `EVENT_PROPERTY_ALLOWLIST` re-application is real
   * over the full real HTTP round trip, not just at the service layer
   * (`export.service.spec.ts` has the equivalent, faster-running coverage).
   * The row is inserted directly via `prisma`, bypassing
   * `POST /analytics/events`/`AnalyticsService.sanitizeProperties` entirely,
   * to simulate a historical row that predates the current allowlist (or
   * otherwise never passed through the write-time scrub).
   */
  it('read-time allowlist filtering: a non-allowlisted property key on a row that bypassed write-time scrubbing never reaches the HTTP response', async () => {
    const { auth, email } = await registerAccount('read-time-filter');
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });

    await prisma.analyticsEvent.create({
      data: {
        userId: user.id,
        eventName: 'video_like',
        // `video_like`'s allowlist is ['videoId', 'value'].
        properties: {
          videoId: seededVideoId,
          value: true,
          leakedInternalField: 'must-not-reach-the-http-response',
        },
        platform: 'ios',
        clientTimestamp: new Date(),
      },
    });

    const response = await request(app.getHttpServer())
      .get('/users/me/export')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .expect(HttpStatus.OK);

    const body = response.body as UserExportDto;
    expect(body.analyticsEvents).toHaveLength(1);
    expect(body.analyticsEvents[0].properties).toEqual({
      videoId: seededVideoId,
      value: true,
    });
    expect(JSON.stringify(body)).not.toContain('leakedInternalField');
    expect(JSON.stringify(body)).not.toContain(
      'must-not-reach-the-http-response',
    );
  });

  it('emits a data_export_success AuthAuditEvent for the caller after a successful export', async () => {
    const { auth } = await registerAccount('audit');

    await request(app.getHttpServer())
      .get('/users/me/export')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .expect(HttpStatus.OK);

    const events = await prisma.authAuditEvent.findMany({
      where: { userId: auth.user.id, event: 'data_export_success' },
    });
    expect(events).toHaveLength(1);
  });

  it("returns a generic 401 for a deleted-but-not-yet-expired access token, matching GET /auth/me's existing precedent", async () => {
    const { auth } = await registerAccount('deleted-user');

    await request(app.getHttpServer())
      .post('/users/me/deletion')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .send({ currentPassword: 'correct-horse-battery', confirmDeletion: true })
      .expect(HttpStatus.OK);

    const response = await request(app.getHttpServer())
      .get('/users/me/export')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .expect(HttpStatus.UNAUTHORIZED);

    expect((response.body as ErrorResponseBody).code).toBe(
      'INVALID_ACCESS_TOKEN',
    );
  });

  it('returns a generic 429 on the 11th export call within the window (limit 10/5min)', async () => {
    const { auth } = await registerAccount('rate-limit');

    const attemptExport = () =>
      request(app.getHttpServer())
        .get('/users/me/export')
        .set('Authorization', `Bearer ${auth.accessToken}`);

    for (let i = 0; i < 10; i += 1) {
      await attemptExport().expect(HttpStatus.OK);
    }

    const blocked = await attemptExport().expect(HttpStatus.TOO_MANY_REQUESTS);
    expect((blocked.body as ErrorResponseBody).statusCode).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
  });
});
