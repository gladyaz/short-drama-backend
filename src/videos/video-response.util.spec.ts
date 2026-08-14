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
  });

  describe('toVideoResponseDto', () => {
    it('builds the public shape with a /stream playbackUrl', () => {
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
      });
    });
  });
});
