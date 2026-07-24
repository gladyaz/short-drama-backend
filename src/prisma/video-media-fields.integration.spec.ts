import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from './prisma.service';

/**
 * Integration-style spec (Phase 11, work unit 11A-2) confirming the
 * additive `Video` schema change — nullable `objectStorageKey` /
 * `objectStorageVariant` / `coverImageKey` / `thumbnailImageKey` plus
 * `lifecycleState` (default `"published"`) — behaves as intended: existing
 * rows (and any caller creating a row without the new fields, mirroring how
 * `prisma/seed.ts` creates the 40 pre-existing catalog rows) stay valid and
 * default to `"published"`, while the new object-storage fields can be
 * populated once a video is actually uploaded via the future 11B-3 admin
 * API. Follows the existing `*-model.integration.spec.ts` precedent: real
 * `PrismaService` against the project's Postgres test database, fully
 * self-cleaning via `afterEach`.
 */
describe('Video model — object storage / lifecycle fields (Prisma integration, 11A-2)', () => {
  let service: PrismaService;
  const testIdPrefix = 'video-media-fields-spec-11a2';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();

    service = module.get<PrismaService>(PrismaService);
    await service.onModuleInit();
  });

  afterEach(async () => {
    await service.video.deleteMany({
      where: { seriesId: `${testIdPrefix}-series` },
    });
    await service.onModuleDestroy();
  });

  const baseVideoData = {
    seriesId: `${testIdPrefix}-series`,
    title: 'Media Fields Spec Video',
    episodeNumber: 1,
    channelName: 'Spec Channel',
    caption: 'Spec caption',
    category: 'drama',
    storageKey: 'Spec Series/1_subtitled.mp4',
    sourceLanguage: 'zh',
    hasEmbeddedIndonesianSubtitle: true,
    likeCount: 0,
  };

  it('defaults lifecycleState to "published" and leaves object-storage fields null when a row is created without them (matches every pre-existing row)', async () => {
    const created = await service.video.create({
      data: { id: `${testIdPrefix}-01`, ...baseVideoData },
    });

    expect(created.lifecycleState).toBe('published');
    expect(created.objectStorageKey).toBeNull();
    expect(created.objectStorageVariant).toBeNull();
    expect(created.coverImageKey).toBeNull();
    expect(created.thumbnailImageKey).toBeNull();
    // The pre-existing local-storage streaming path is untouched by this
    // migration: `storageKey` still round-trips exactly as before.
    expect(created.storageKey).toBe(baseVideoData.storageKey);
  });

  it('persists explicit object-storage keys, variant, and a non-default lifecycleState', async () => {
    const created = await service.video.create({
      data: {
        id: `${testIdPrefix}-02`,
        ...baseVideoData,
        lifecycleState: 'draft',
        objectStorageKey: 'r2/videos/spec-02/source.mp4',
        objectStorageVariant: 'source',
        coverImageKey: 'r2/covers/spec-02.jpg',
        thumbnailImageKey: 'r2/thumbnails/spec-02.jpg',
      },
    });

    expect(created.lifecycleState).toBe('draft');
    expect(created.objectStorageKey).toBe('r2/videos/spec-02/source.mp4');
    expect(created.objectStorageVariant).toBe('source');
    expect(created.coverImageKey).toBe('r2/covers/spec-02.jpg');
    expect(created.thumbnailImageKey).toBe('r2/thumbnails/spec-02.jpg');

    const found = await service.video.findUnique({
      where: { id: created.id },
    });
    expect(found?.lifecycleState).toBe('draft');
  });

  it('can filter by lifecycleState, matching the indexed column added by this migration', async () => {
    await service.video.create({
      data: { id: `${testIdPrefix}-03`, ...baseVideoData, episodeNumber: 3 },
    });
    await service.video.create({
      data: {
        id: `${testIdPrefix}-04`,
        ...baseVideoData,
        episodeNumber: 4,
        lifecycleState: 'draft',
      },
    });

    const draftRows = await service.video.findMany({
      where: {
        seriesId: `${testIdPrefix}-series`,
        lifecycleState: 'draft',
      },
    });

    expect(draftRows.map((row) => row.id)).toEqual([`${testIdPrefix}-04`]);
  });
});
