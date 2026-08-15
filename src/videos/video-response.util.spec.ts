import { VideoContentKind } from './video-content-kind.types';
import {
  toVideoContentKind,
  toVideoRecord,
  toVideoResponseDto,
} from './video-response.util';

/**
 * Work unit "SERIES METADATA + DISCOVER ARTWORK CONTRACT": unit coverage
 * for the pure mapping functions extracted from `VideosService` (see that
 * file's own doc comment for why). These were previously exercised only
 * indirectly through `VideosService#findAll`/`#findById`
 * (`videos.service.spec.ts`, unchanged and still passing) — this file adds
 * direct, isolated coverage now that they are standalone, exported,
 * network/DB-free functions.
 */
describe('video-response.util', () => {
  describe('toVideoContentKind', () => {
    it('returns DRAMA for "drama"', () => {
      expect(toVideoContentKind('drama')).toBe(VideoContentKind.DRAMA);
    });

    it('returns QA_FIXTURE for "qa_fixture"', () => {
      expect(toVideoContentKind('qa_fixture')).toBe(
        VideoContentKind.QA_FIXTURE,
      );
    });

    it('fails open to DRAMA for an unrecognised value', () => {
      expect(toVideoContentKind('trailer')).toBe(VideoContentKind.DRAMA);
    });
  });

  describe('toVideoRecord', () => {
    const baseRow = {
      id: 'video-response-util-spec-01',
      seriesId: 'video-response-util-spec-series',
      title: 'Spec Title',
      episodeNumber: 1,
      channelName: 'Spec Channel',
      caption: 'Spec caption',
      category: 'drama',
      storageKey: 'Spec/1.mp4',
      sourceLanguage: 'zh',
      hasEmbeddedIndonesianSubtitle: true,
      likeCount: 5,
      durationSeconds: null,
      width: null,
      height: null,
      contentKind: 'drama',
      accessTierOverride: null,
    };

    it('converts null optional columns to undefined', () => {
      const record = toVideoRecord(baseRow);
      expect(record.durationSeconds).toBeUndefined();
      expect(record.width).toBeUndefined();
      expect(record.height).toBeUndefined();
    });

    it('preserves present optional values', () => {
      const record = toVideoRecord({
        ...baseRow,
        durationSeconds: 120,
        width: 720,
        height: 1280,
      });
      expect(record.durationSeconds).toBe(120);
      expect(record.width).toBe(720);
      expect(record.height).toBe(1280);
    });

    it('narrows contentKind via toVideoContentKind', () => {
      const record = toVideoRecord({ ...baseRow, contentKind: 'qa_fixture' });
      expect(record.contentKind).toBe(VideoContentKind.QA_FIXTURE);
    });

    it('preserves the raw accessTierOverride value', () => {
      expect(
        toVideoRecord({ ...baseRow, accessTierOverride: 'premium' })
          .accessTierOverride,
      ).toBe('premium');
      expect(
        toVideoRecord({ ...baseRow, accessTierOverride: null })
          .accessTierOverride,
      ).toBeNull();
    });
  });

  describe('toVideoResponseDto', () => {
    it('builds the public shape with a /stream playbackUrl and a resolved accessTier', () => {
      const dto = toVideoResponseDto(
        {
          id: 'video-response-util-spec-02',
          seriesId: 'video-response-util-spec-series',
          title: 'Spec Title',
          episodeNumber: 2,
          channelName: 'Spec Channel',
          caption: 'Spec caption',
          category: 'drama',
          storageKey: 'Spec/2.mp4',
          sourceLanguage: 'zh',
          hasEmbeddedIndonesianSubtitle: true,
          likeCount: 3,
          contentKind: VideoContentKind.DRAMA,
          accessTierOverride: null,
        },
        'http://localhost:3000',
      );

      expect(dto).toEqual({
        id: 'video-response-util-spec-02',
        seriesId: 'video-response-util-spec-series',
        title: 'Spec Title',
        episodeNumber: 2,
        channelName: 'Spec Channel',
        caption: 'Spec caption',
        category: 'drama',
        storageKey: 'Spec/2.mp4',
        playbackUrl:
          'http://localhost:3000/videos/video-response-util-spec-02/stream',
        sourceLanguage: 'zh',
        hasEmbeddedIndonesianSubtitle: true,
        likeCount: 3,
        durationSeconds: undefined,
        width: undefined,
        height: undefined,
        contentKind: VideoContentKind.DRAMA,
        accessTier: 'free',
      });
    });

    /**
     * Work unit "Episode Access-Tier + Category Contract Hardening":
     * boundary coverage for the resolved `accessTier` field, proving it
     * follows the SAME override-vs-default rule as
     * `EntitlementsService.resolveEpisodePremium`
     * (`FREE_EPISODE_LIMIT = 5`).
     */
    describe('accessTier resolution', () => {
      const buildRecord = (overrides: {
        episodeNumber: number;
        accessTierOverride: string | null;
      }) => ({
        id: 'video-response-util-spec-tier',
        seriesId: 'video-response-util-spec-series',
        title: 'Spec Title',
        episodeNumber: overrides.episodeNumber,
        channelName: 'Spec Channel',
        caption: 'Spec caption',
        category: 'drama',
        storageKey: 'Spec/tier.mp4',
        sourceLanguage: 'zh',
        hasEmbeddedIndonesianSubtitle: true,
        likeCount: 0,
        contentKind: VideoContentKind.DRAMA,
        accessTierOverride: overrides.accessTierOverride,
      });

      it('no override, early episode (<= FREE_EPISODE_LIMIT): resolves free', () => {
        const dto = toVideoResponseDto(
          buildRecord({ episodeNumber: 1, accessTierOverride: null }),
          'http://localhost:3000',
        );
        expect(dto.accessTier).toBe('free');
      });

      it('no override, late episode (> FREE_EPISODE_LIMIT): resolves premium', () => {
        const dto = toVideoResponseDto(
          buildRecord({ episodeNumber: 6, accessTierOverride: null }),
          'http://localhost:3000',
        );
        expect(dto.accessTier).toBe('premium');
      });

      it('explicit "free" beats a default-premium episode', () => {
        const dto = toVideoResponseDto(
          buildRecord({ episodeNumber: 6, accessTierOverride: 'free' }),
          'http://localhost:3000',
        );
        expect(dto.accessTier).toBe('free');
      });

      it('explicit "premium" beats a default-free episode', () => {
        const dto = toVideoResponseDto(
          buildRecord({ episodeNumber: 1, accessTierOverride: 'premium' }),
          'http://localhost:3000',
        );
        expect(dto.accessTier).toBe('premium');
      });

      it('the raw accessTierOverride is never present on the public DTO', () => {
        const dto = toVideoResponseDto(
          buildRecord({ episodeNumber: 6, accessTierOverride: 'free' }),
          'http://localhost:3000',
        );
        expect(dto).not.toHaveProperty('accessTierOverride');
      });
    });
  });
});
