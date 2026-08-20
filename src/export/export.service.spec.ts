import { Test, TestingModule } from '@nestjs/testing';
import { EVENT_PROPERTY_ALLOWLIST } from '../analytics/analytics.types';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { ExportService } from './export.service';
import {
  fixtureEmail,
  fixturePhone,
} from '../common/testing/fixture-namespace.helpers';

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
    // `AnalyticsEvent.userId` is `onDelete: SetNull` (not `Cascade`, unlike
    // the three models above) — this MUST run before `user.deleteMany`
    // below, or these rows would survive with `userId: null` and leak into
    // a later test run's "no analytics rows" fixtures.
    await prisma.analyticsEvent.deleteMany({
      where: { user: { email: { contains: testIdPrefix } } },
    });
    await prisma.video.deleteMany({
      where: { id: { contains: testIdPrefix } },
    });
    // Cascades with `User` below, but cleaned explicitly to match this
    // teardown's existing "explicit even when cascade-redundant" style.
    await prisma.authIdentity.deleteMany({
      where: { user: { email: { contains: testIdPrefix } } },
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
      // PHASE 10B: linked authentication methods are part of the personal
      // data this export must report (see `ExportedProfileDto`). Empty here
      // because this fixture inserts its `User` row directly rather than
      // going through `AuthService.register`, which is what creates the
      // `email` identity — the dedicated test below covers a populated one.
      authIdentities: [],
    });
    expect(result.interactions).toEqual([]);
    expect(result.watchProgress).toEqual([]);
    expect(result.entitlements).toEqual([]);
    expect(result.analyticsEvents).toEqual([]);
    expect(typeof result.exportedAt).toBe('string');
    expect(new Date(result.exportedAt).toString()).not.toBe('Invalid Date');
  });

  it('reports every linked authentication method, transformed for export', async () => {
    // PHASE 10B. The phone number is reported IN FULL here, unlike
    // `GET /auth/identities` which masks it: this endpoint exists to tell
    // the account owner exactly what is stored about them, and a masked
    // value would defeat that. `providerSubject` is deliberately absent —
    // for `google` it is an opaque identifier meaningful only to Google, and
    // echoing it into a downloadable file gives the person nothing while
    // creating a cross-provider correlation handle.
    const verifiedAt = new Date('2026-08-20T10:00:00.000Z');
    // Namespaced fixtures, NOT literals: `AuthIdentity` enforces
    // `@@unique([provider, providerSubject])`, so two concurrent Jest runs
    // sharing this database would collide on any fixed email/phone — the
    // exact failure mode `fixture-namespace.helpers.ts` exists to prevent.
    const identityEmail = fixtureEmail('export-identity');
    const identityPhone = fixturePhone();
    await prisma.authIdentity.createMany({
      data: [
        {
          userId,
          provider: 'email',
          providerSubject: identityEmail,
          normalizedIdentifier: identityEmail,
        },
        {
          userId,
          provider: 'whatsapp',
          providerSubject: identityPhone,
          normalizedIdentifier: identityPhone,
          verifiedAt,
        },
      ],
    });

    const result = await service.exportForUser(userId);

    expect(result.profile.authIdentities.map((i) => i.provider).sort()).toEqual(
      ['email', 'whatsapp'],
    );

    const whatsapp = result.profile.authIdentities.find(
      (identity) => identity.provider === 'whatsapp',
    );
    // Reported in FULL, not masked — this endpoint's whole purpose.
    expect(whatsapp?.identifier).toBe(identityPhone);
    expect(whatsapp?.verifiedAt).toBe(verifiedAt.toISOString());

    // `verifiedAt` is NULL for `email` because this application has never
    // implemented email-address verification — claiming otherwise in a
    // person's own data export would be a fabricated record.
    expect(
      result.profile.authIdentities.find((i) => i.provider === 'email')
        ?.verifiedAt,
    ).toBeNull();

    expect(JSON.stringify(result.profile.authIdentities)).not.toContain(
      'providerSubject',
    );
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

  it('ownership isolation: never includes another account interactions/progress/entitlements/analytics events', async () => {
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
    await prisma.analyticsEvent.create({
      data: {
        userId: otherUserId,
        eventName: 'video_play',
        properties: { videoId, seriesId: `${testIdPrefix}-series` },
        platform: 'ios',
        clientTimestamp: new Date(),
      },
    });

    const result = await service.exportForUser(userId);

    expect(result.interactions).toEqual([]);
    expect(result.watchProgress).toEqual([]);
    expect(result.entitlements).toEqual([]);
    expect(result.analyticsEvents).toEqual([]);
  });

  describe('AnalyticsEvent (Phase 12, work unit 12E-B2, DECISIONS.md decision 2)', () => {
    it('exports eventName, receivedAt (as timestamp), platform, and allowlist-filtered properties — no id/userId', async () => {
      const created = await prisma.analyticsEvent.create({
        data: {
          userId,
          eventName: 'video_play',
          properties: {
            videoId,
            seriesId: `${testIdPrefix}-series`,
            episodeNumber: 3,
          },
          platform: 'android',
          clientTimestamp: new Date('2020-01-01T00:00:00.000Z'),
        },
      });

      const result = await service.exportForUser(userId);

      expect(result.analyticsEvents).toEqual([
        {
          eventName: 'video_play',
          timestamp: created.receivedAt.toISOString(),
          platform: 'android',
          properties: {
            videoId,
            seriesId: `${testIdPrefix}-series`,
            episodeNumber: 3,
          },
        },
      ]);
      // The exported timestamp is the server-authoritative `receivedAt`,
      // never the caller-supplied `clientTimestamp` — proves the timestamp
      // judgment call (`export.types.ts`) is actually implemented, not just
      // documented.
      expect(result.analyticsEvents[0].timestamp).not.toBe(
        created.clientTimestamp.toISOString(),
      );
    });

    it('an account with no analytics rows exports an empty analyticsEvents array', async () => {
      const result = await service.exportForUser(userId);
      expect(result.analyticsEvents).toEqual([]);
    });

    it('orders analytics events newest-first (receivedAt desc)', async () => {
      const older = await prisma.analyticsEvent.create({
        data: {
          userId,
          eventName: 'feed_view',
          properties: {},
          platform: 'web',
          clientTimestamp: new Date(),
        },
      });
      await prisma.analyticsEvent.update({
        where: { id: older.id },
        data: { receivedAt: new Date('2025-01-01T00:00:00.000Z') },
      });
      const newer = await prisma.analyticsEvent.create({
        data: {
          userId,
          eventName: 'feed_view',
          properties: {},
          platform: 'web',
          clientTimestamp: new Date(),
        },
      });
      await prisma.analyticsEvent.update({
        where: { id: newer.id },
        data: { receivedAt: new Date('2025-06-01T00:00:00.000Z') },
      });

      const result = await service.exportForUser(userId);

      expect(result.analyticsEvents).toHaveLength(2);
      expect(result.analyticsEvents[0].timestamp).toBe(
        new Date('2025-06-01T00:00:00.000Z').toISOString(),
      );
      expect(result.analyticsEvents[1].timestamp).toBe(
        new Date('2025-01-01T00:00:00.000Z').toISOString(),
      );
    });

    /**
     * The defence-in-depth proof this work unit requires: a row whose
     * `properties` contains a key NOT in `EVENT_PROPERTY_ALLOWLIST` for its
     * `eventName`, inserted directly via `prisma.analyticsEvent.create`
     * (bypassing `AnalyticsService.sanitizeProperties`'s write-time scrub
     * entirely) — simulating a historical row written under a different
     * version of the allowlist, or any other way a non-allowlisted key could
     * have ended up in the column. If the export only trusted the stored
     * value, this key would leak; the read-time filter must strip it.
     *
     * Mutation proof (see this work unit's report): temporarily changing
     * `ExportService.exportForUser`'s analytics mapping from
     * `filterEventPropertiesForExport(row.eventName, row.properties)` to
     * `row.properties as Record<string, string | number | boolean>` (a
     * direct pass-through) makes this test fail, because `secretInternalKey`
     * then appears in the export. Restored byte-for-byte afterward.
     */
    it('read-time allowlist filtering strips a non-allowlisted property key from a row that bypassed the write-time scrub', async () => {
      // `video_play`'s allowlist is ['videoId', 'seriesId', 'episodeNumber']
      // (`EVENT_PROPERTY_ALLOWLIST`, analytics.types.ts) — `secretInternalKey`
      // is deliberately not one of them.
      await prisma.analyticsEvent.create({
        data: {
          userId,
          eventName: 'video_play',
          properties: {
            videoId,
            secretInternalKey: 'should-never-be-exported',
          },
          platform: 'ios',
          clientTimestamp: new Date(),
        },
      });

      const result = await service.exportForUser(userId);

      expect(result.analyticsEvents).toHaveLength(1);
      expect(result.analyticsEvents[0].properties).toEqual({ videoId });
      expect(result.analyticsEvents[0].properties).not.toHaveProperty(
        'secretInternalKey',
      );
      expect(JSON.stringify(result)).not.toContain('secretInternalKey');
      expect(JSON.stringify(result)).not.toContain('should-never-be-exported');
    });

    it('strips all properties for a known event whose own allowlist is empty (feed_view)', async () => {
      await prisma.analyticsEvent.create({
        data: {
          userId,
          eventName: 'feed_view',
          // `feed_view`'s allowlist is [] — every key here is a bypass.
          properties: { unexpectedKey: 'leak-me', anotherOne: 42 },
          platform: 'web',
          clientTimestamp: new Date(),
        },
      });

      const result = await service.exportForUser(userId);

      expect(result.analyticsEvents).toHaveLength(1);
      expect(result.analyticsEvents[0].properties).toEqual({});
    });

    /**
     * The gap this test closes (found in independent review of this work
     * unit): the sibling test above ("strips all properties for a known
     * event whose own allowlist is empty") uses `eventName: 'feed_view'`,
     * which IS a key in `EVENT_PROPERTY_ALLOWLIST` (with an empty property
     * list) — it does not exercise an `eventName` that is absent from the
     * allowlist entirely. `AnalyticsEvent.eventName` is a plain `String`
     * column with no DB-level enum (`prisma/schema.prisma`), so a row whose
     * `eventName` predates an allowlist change, or was written by an older
     * client version, is a real historical shape that can exist in the
     * table today. `filterEventPropertiesForExport`'s `EVENT_PROPERTY_ALLOWLIST[eventName]
     * ?? []` fallback is written to handle exactly this case; this test
     * proves it actually does, for a genuinely unrecognized `eventName`
     * rather than a known one with an empty list.
     *
     * Mutation proof (see this fix's report): temporarily changing
     * `ExportService.exportForUser`'s analytics mapping from
     * `filterEventPropertiesForExport(row.eventName, row.properties)` to
     * `row.properties as Record<string, string | number | boolean>` (a
     * direct pass-through) makes this test fail, because `secretPayload`
     * then appears in the export. Restored byte-for-byte afterward.
     */
    it('strips all properties for an eventName absent from EVENT_PROPERTY_ALLOWLIST entirely (unrecognized historical event)', async () => {
      const unknownEventName = 'legacy_unrecognized_event';
      expect(Object.keys(EVENT_PROPERTY_ALLOWLIST)).not.toContain(
        unknownEventName,
      );

      await prisma.analyticsEvent.create({
        data: {
          userId,
          eventName: unknownEventName,
          properties: { secretPayload: 'leak-me', anotherOne: 42 },
          platform: 'web',
          clientTimestamp: new Date(),
        },
      });

      const result = await service.exportForUser(userId);

      expect(result.analyticsEvents).toHaveLength(1);
      expect(result.analyticsEvents[0].properties).toEqual({});
      expect(JSON.stringify(result)).not.toContain('secretPayload');
      expect(JSON.stringify(result)).not.toContain('leak-me');
    });
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
    const analyticsEvent = await prisma.analyticsEvent.create({
      data: {
        userId,
        eventName: 'video_play',
        properties: { videoId },
        platform: 'ios',
        clientTimestamp: new Date(),
      },
    });

    const result = await service.exportForUser(userId);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('irrelevant-for-this-spec');
    expect(serialized).not.toContain('Spec Series/1_subtitled.mp4');
    expect(serialized).not.toContain(userId);
    expect(serialized).not.toContain(entitlement.id);
    expect(serialized).not.toContain(interaction.id);
    expect(serialized).not.toContain(analyticsEvent.id);
    // Field-name-level assertion: not just "this particular id value is
    // absent," but that the DTO never has a reason to carry an `"id":` key
    // at all, anywhere in the document, regardless of value.
    expect(serialized).not.toContain('"id":');
  });
});
