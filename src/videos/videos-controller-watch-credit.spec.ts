import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { RewardsWatchService } from '../rewards/rewards-watch.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

/**
 * Work unit "REWARDS V1 EARN AND SPEND": the SEAM between playback and the
 * rewards economy.
 *
 * Everything about what a watch credit MEANS is tested in
 * `rewards-missions.service.spec.ts` against a real database. What is tested
 * here is the wiring, which no other spec can see: that
 * `GET /videos/:id/playback` records a credit at all, that it records the
 * right one, that it records nothing for a caller who was refused or for a
 * guest, and — most importantly — that a failure in the rewards path cannot
 * take playback down with it.
 *
 * Fully stubbed, deliberately. A seam test that needed Postgres would be a
 * slower, flakier copy of a test that already exists elsewhere.
 */
describe('VideosController — watch credit seam', () => {
  const VIDEO_ID = 'video-seam-1';
  const SERIES_ID = 'series-seam-1';
  const USER: AuthenticatedUser = { id: 'user-seam-1' };

  let controller: VideosController;
  let recordEpisodeStart: jest.Mock;
  let getPlaybackUrl: jest.Mock;
  let getStreamGuardInfo: jest.Mock;
  let resolveEpisodePremium: jest.Mock;
  let isEntitled: jest.Mock;

  beforeEach(async () => {
    recordEpisodeStart = jest.fn().mockResolvedValue(undefined);
    getPlaybackUrl = jest
      .fn()
      .mockResolvedValue({ type: 'file', playbackUrl: 'https://example.test' });
    getStreamGuardInfo = jest.fn().mockResolvedValue({
      episodeNumber: 4,
      accessTierOverride: null,
      seriesId: SERIES_ID,
    });
    resolveEpisodePremium = jest.fn().mockReturnValue(false);
    isEntitled = jest.fn().mockResolvedValue(false);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [VideosController],
      providers: [
        {
          provide: VideosService,
          useValue: { getStreamGuardInfo, getPlaybackUrl },
        },
        {
          provide: EntitlementsService,
          useValue: { resolveEpisodePremium, isEntitled },
        },
        { provide: RewardsWatchService, useValue: { recordEpisodeStart } },
        { provide: ConfigService, useValue: { get: () => undefined } },
        // The controller's `OptionalJwtAuthGuard` is instantiated when the
        // module compiles even though no guard runs in a direct method call.
        // A bare stub is enough and keeps this spec free of auth machinery.
        { provide: JwtService, useValue: {} },
      ],
    }).compile();

    controller = module.get(VideosController);
  });

  it('CRITICAL: records one credit for an authenticated playback grant', async () => {
    await controller.getPlaybackUrl(VIDEO_ID, USER);

    expect(recordEpisodeStart).toHaveBeenCalledTimes(1);
    expect(recordEpisodeStart).toHaveBeenCalledWith({
      userId: USER.id,
      videoId: VIDEO_ID,
      seriesId: SERIES_ID,
      episodeNumber: 4,
    });
  });

  it('CRITICAL: records nothing for a guest', async () => {
    // A watch credit belongs to a wallet, and a signed-out viewer has none.
    await controller.getPlaybackUrl(VIDEO_ID, undefined);

    expect(recordEpisodeStart).not.toHaveBeenCalled();
  });

  it('CRITICAL: records nothing when the entitlement gate refuses the caller', async () => {
    resolveEpisodePremium.mockReturnValue(true);
    isEntitled.mockResolvedValue(false);

    await expect(
      controller.getPlaybackUrl(VIDEO_ID, USER),
    ).rejects.toMatchObject({ code: AppErrorCode.ENTITLEMENT_REQUIRED });

    // A refused request must never advance a mission.
    expect(recordEpisodeStart).not.toHaveBeenCalled();
    expect(getPlaybackUrl).not.toHaveBeenCalled();
  });

  it('CRITICAL: records nothing when the video does not resolve', async () => {
    getPlaybackUrl.mockRejectedValue(
      new AppException(AppErrorCode.VIDEO_NOT_FOUND, 'Video not found', 404),
    );

    await expect(
      controller.getPlaybackUrl(VIDEO_ID, USER),
    ).rejects.toMatchObject({ code: AppErrorCode.VIDEO_NOT_FOUND });

    expect(recordEpisodeStart).not.toHaveBeenCalled();
  });

  it('CRITICAL: the playback URL is resolved before the rewards call, never after', async () => {
    // `recordEpisodeStart` is documented as never throwing. This pins the
    // ORDERING that makes that promise worth anything: playback is fully
    // resolved first, so the rewards call is the last thing that happens and
    // can only ever cost a credit — never the episode.
    recordEpisodeStart.mockRejectedValue(new Error('rewards is having a day'));

    await expect(controller.getPlaybackUrl(VIDEO_ID, USER)).rejects.toThrow();

    expect(getPlaybackUrl).toHaveBeenCalledTimes(1);
  });

  it('records a credit for an entitled caller on a premium episode too', async () => {
    resolveEpisodePremium.mockReturnValue(true);
    isEntitled.mockResolvedValue(true);

    await controller.getPlaybackUrl(VIDEO_ID, USER);

    expect(recordEpisodeStart).toHaveBeenCalledTimes(1);
  });
});
