import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { fixtureMarker } from '../../common/testing/fixture-namespace.helpers';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { derivePrefixFromMasterKey } from '../hls/hls-playback-token.util';
import {
  HlsPlaybackResponseDto,
  VideoPlaybackResponseDto,
} from '../../videos/video.types';
import { VideosService } from '../../videos/videos.service';
import { HlsDemoteService } from './hls-demote.service';

/**
 * Work unit "HLS DEMOTE", PLAYBACK CONSEQUENCES. The whole point of a
 * demotion is what `GET /videos/:id/playback` answers afterwards, so this
 * proves it end to end at the service level, against the real database:
 * `VideosService.getPlaybackUrl` is called BEFORE and AFTER
 * `HlsDemoteService.run`, on the same row, in the same test.
 *
 * The truthful post-demotion answer is NOT invented here — it is whatever
 * the pre-existing, unchanged `resolvePlaybackSource` rule already produces
 * for that row (R2 MP4 → local `/stream` → fail closed). These tests assert
 * each of those three outcomes on a row set up to produce it.
 */
const TEST_APP_CONFIG = {
  port: 3000,
  publicBaseUrl: 'http://localhost:3000',
  storageRoot: '/company/storage',
  corsOrigins: ['http://localhost:8081'],
};

const TEST_HLS_GATEWAY_CONFIG = {
  baseUrl: 'https://hls-gateway.example.test',
  tokenSecret: 'hls-demote-playback-spec-token-secret',
  ttlSeconds: 3600,
};

describe('playback after an HLS demotion', () => {
  let videosService: VideosService;
  let demoteService: HlsDemoteService;
  let prisma: PrismaService;
  let storageService: {
    headObject: jest.Mock;
    deleteObject: jest.Mock;
    createPresignedGetUrl: jest.Mock;
  };

  const testIdPrefix = fixtureMarker('hls-demote-playback');
  const seriesId = `${testIdPrefix}-series`;

  function masterKeyFor(id: string, version: number): string {
    return `admin-media/${id}/hls/v${version}-a1-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/master.m3u8`;
  }

  async function createReadyHlsVideo(
    id: string,
    overrides: Partial<{
      objectStorageKey: string | null;
      storageKey: string;
    }> = {},
  ): Promise<void> {
    await prisma.video.create({
      data: {
        id,
        seriesId,
        title: 'Fixture',
        episodeNumber: 1,
        channelName: 'Fixture Channel',
        caption: 'Fixture caption',
        category: 'drama',
        storageKey: overrides.storageKey ?? '',
        sourceLanguage: 'zh',
        hasEmbeddedIndonesianSubtitle: true,
        likeCount: 0,
        lifecycleState: 'published',
        objectStorageKey:
          overrides.objectStorageKey === undefined
            ? `admin-media/${id}/source`
            : overrides.objectStorageKey,
        processingState: 'ready',
        processingVersion: 3,
        hlsMasterKey: masterKeyFor(id, 3),
        hlsRenditions: [
          { name: '360p', width: 360, height: 640, bandwidth: 800_000 },
          { name: '720p', width: 720, height: 1280, bandwidth: 2_800_000 },
        ] as never,
        transcodeProfileVersion: 'ladder-v1',
      },
    });
  }

  beforeEach(async () => {
    storageService = {
      headObject: jest.fn().mockResolvedValue({ contentLength: 12_345 }),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      createPresignedGetUrl: jest.fn().mockResolvedValue({
        url: 'https://r2.example.test/signed-source.mp4?sig=redacted',
        expiresAt: new Date(Date.now() + 3600_000),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        HlsDemoteService,
        PrismaService,
        { provide: StorageService, useValue: storageService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'hlsGateway' ? TEST_HLS_GATEWAY_CONFIG : TEST_APP_CONFIG,
            ),
          },
        },
      ],
    }).compile();

    videosService = module.get(VideosService);
    demoteService = module.get(HlsDemoteService);
    prisma = module.get(PrismaService);
    await prisma.onModuleInit();
  });

  afterEach(async () => {
    if (prisma) {
      await prisma.video.deleteMany({ where: { seriesId } });
      await prisma.onModuleDestroy();
    }
  });

  it('advertises HLS before the demotion and the R2 MP4 after it', async () => {
    const id = `${testIdPrefix}-r2`;
    await createReadyHlsVideo(id);

    const before = (await videosService.getPlaybackUrl(
      id,
    )) as HlsPlaybackResponseDto;
    expect(before.type).toBe('hls');
    expect(before.renditions.map((rendition) => rendition.quality)).toEqual([
      '360p',
      '720p',
    ]);

    const report = await demoteService.run({
      videoId: id,
      expectedGeneration: 3,
      apply: true,
      allowUnplayable: false,
    });
    expect(report.demoted).toBe(true);

    const after = (await videosService.getPlaybackUrl(
      id,
    )) as VideoPlaybackResponseDto;
    expect('type' in after).toBe(false);
    expect(after.playbackUrl).toBe(
      'https://r2.example.test/signed-source.mp4?sig=redacted',
    );
    expect(storageService.createPresignedGetUrl).toHaveBeenCalledWith(
      `admin-media/${id}/source`,
      expect.anything(),
    );
  });

  it('advertises no master playlist, no rendition and no speculative quality after the demotion', async () => {
    const id = `${testIdPrefix}-no-leak`;
    await createReadyHlsVideo(id);
    const demotedMaster = masterKeyFor(id, 3);
    const demotedPrefix = derivePrefixFromMasterKey(id, demotedMaster);

    await demoteService.run({
      videoId: id,
      expectedGeneration: 3,
      apply: true,
      allowUnplayable: false,
    });

    const after = await videosService.getPlaybackUrl(id);
    const serialized = JSON.stringify(after);

    expect(serialized).not.toContain(demotedMaster);
    expect(serialized).not.toContain(demotedPrefix);
    expect(serialized).not.toContain('master.m3u8');
    expect(serialized).not.toContain('index.m3u8');
    expect(serialized).not.toContain('360p');
    expect(serialized).not.toContain('720p');
    expect(serialized).not.toContain('1080p');
  });

  it('falls back to the local /stream URL for a row whose bytes are local-only', async () => {
    const id = `${testIdPrefix}-local`;
    await createReadyHlsVideo(id, {
      objectStorageKey: null,
      storageKey: 'Series 104/1_subtitled.mp4',
    });

    await demoteService.run({
      videoId: id,
      expectedGeneration: 3,
      apply: true,
      allowUnplayable: false,
    });

    const after = (await videosService.getPlaybackUrl(
      id,
    )) as VideoPlaybackResponseDto;
    expect(after.playbackUrl).toBe(
      `${TEST_APP_CONFIG.publicBaseUrl}/videos/${id}/stream`,
    );
    expect(storageService.createPresignedGetUrl).not.toHaveBeenCalled();
  });

  it('answers 409 MEDIA_PLAYBACK_SOURCE_UNAVAILABLE — never a faked MP4 — when the row genuinely has no source', async () => {
    const id = `${testIdPrefix}-unavailable`;
    await createReadyHlsVideo(id, { objectStorageKey: null, storageKey: '' });

    await demoteService.run({
      videoId: id,
      expectedGeneration: 3,
      apply: true,
      allowUnplayable: true,
    });

    await expect(videosService.getPlaybackUrl(id)).rejects.toMatchObject({
      code: 'MEDIA_PLAYBACK_SOURCE_UNAVAILABLE',
    });
  });

  it('the token gateway can no longer be handed a grant for the demoted generation', async () => {
    const id = `${testIdPrefix}-token`;
    await createReadyHlsVideo(id);

    await demoteService.run({
      videoId: id,
      expectedGeneration: 3,
      apply: true,
      allowUnplayable: false,
    });

    // The mint path is driven entirely by the row's `hlsMasterKey`, which is
    // now NULL — so there is no prefix left to authorize.
    const row = await prisma.video.findUniqueOrThrow({ where: { id } });
    expect(derivePrefixFromMasterKey(id, row.hlsMasterKey)).toBeNull();
  });

  it('a dry run changes nothing about what playback advertises', async () => {
    const id = `${testIdPrefix}-dry`;
    await createReadyHlsVideo(id);

    const before = (await videosService.getPlaybackUrl(
      id,
    )) as HlsPlaybackResponseDto;

    await demoteService.run({
      videoId: id,
      expectedGeneration: 3,
      apply: false,
      allowUnplayable: false,
    });

    const after = (await videosService.getPlaybackUrl(
      id,
    )) as HlsPlaybackResponseDto;

    expect(after.type).toBe('hls');
    expect(after.renditions.map((rendition) => rendition.url)).toEqual(
      before.renditions.map((rendition) => rendition.url),
    );
  });
});
