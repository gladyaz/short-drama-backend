import { VideoRecord } from './video.types';

/**
 * Hardcoded metadata for the Phase 5A POC. storageKey values are relative to
 * STORAGE_ROOT and were verified to point at real, playable company MP4 files
 * during read-only inspection of the storage folder.
 *
 * As of Phase 8 (work unit 8-B4), `VideosService` no longer reads this array
 * directly at runtime — the live source of truth is the `Video` table via
 * Prisma. This array is now consumed by `prisma/seed.ts` to populate that
 * table, so it remains the single source of truth for the catalog's *seed*
 * data (avoiding a second, hand-retyped copy that could drift).
 */

interface SeriesEpisodesInput {
  seriesId: string;
  idPrefix: string;
  title: string;
  channelName: string;
  category: string;
  folderName: string;
  fileNames: string[];
  baseLikeCount: number;
  /** Pixel dimensions measured with ffprobe against episode 1; assumed
   * uniform across the series' episodes (same source encode). */
  width: number;
  height: number;
}

function buildSeriesEpisodes(input: SeriesEpisodesInput): VideoRecord[] {
  return input.fileNames.map((fileName, index) => {
    const episodeNumber = index + 1;
    return {
      id: `${input.idPrefix}-${String(episodeNumber).padStart(2, '0')}`,
      seriesId: input.seriesId,
      title: `${input.title} - Episode ${episodeNumber}`,
      episodeNumber,
      channelName: input.channelName,
      caption: `Episode ${episodeNumber} dari ${input.title}.`,
      category: input.category,
      storageKey: `${input.folderName}/${fileName}`,
      sourceLanguage: 'zh',
      hasEmbeddedIndonesianSubtitle: true,
      likeCount: input.baseLikeCount + (input.fileNames.length - index) * 2,
      width: input.width,
      height: input.height,
    };
  });
}

export const VIDEOS: VideoRecord[] = [
  ...buildSeriesEpisodes({
    seriesId: 'series-104',
    idPrefix: 'video-104',
    title: 'Malapetaka Datang: Benteng Bergerakku',
    channelName: 'VideoDracin Originals',
    category: 'action',
    width: 720,
    height: 1280,
    folderName: 'Series 104',
    fileNames: [
      '1_subtitled.mp4',
      '2_subtitled.mp4',
      '3_subtitled.mp4',
      '4_subtitled.mp4',
      '5_subtitled.mp4',
      '6_subtitled.mp4',
      '7_subtitled.mp4',
      '8_subtitled.mp4',
      '9_subtitled.mp4',
      '10_subtitled.mp4',
    ],
    baseLikeCount: 60,
  }),
  ...buildSeriesEpisodes({
    seriesId: 'series-010',
    idPrefix: 'video-010',
    title: 'Kue Gulung Kaya Raya: Kedaiku Menembus Waktu',
    channelName: 'VideoDracin Originals',
    category: 'comedy',
    width: 1280,
    height: 720,
    folderName: 'Series-10',
    fileNames: [
      '1_subtitled.mp4',
      '2_subtitled.mp4',
      '3_subtitled.mp4',
      '4_subtitled.mp4',
      '5_subtitled.mp4',
      '6_subtitled.mp4',
      '7_subtitled.mp4',
      '8_subtitled.mp4',
      '9_subtitled.mp4',
      '10_subtitled.mp4',
    ],
    baseLikeCount: 60,
  }),
  ...buildSeriesEpisodes({
    seriesId: 'series-101',
    idPrefix: 'video-101',
    title: 'Hidup Bahagiaku Bersama Sang Permaisuri',
    channelName: 'VideoDracin Originals',
    category: 'romance',
    width: 720,
    height: 1280,
    folderName: 'Series-101',
    fileNames: [
      '第1集_subtitled.mp4',
      '第2集_subtitled.mp4',
      '第3集_subtitled.mp4',
      '第4集_subtitled.mp4',
      '第5集_subtitled.mp4',
      '第6集_subtitled.mp4',
      '第7集_subtitled.mp4',
      '第8集_subtitled.mp4',
      '第9集_subtitled.mp4',
      '第10集_subtitled.mp4',
    ],
    baseLikeCount: 60,
  }),
  ...buildSeriesEpisodes({
    seriesId: 'series-105',
    idPrefix: 'video-105',
    title: 'Hati Yin yang Jahat: Antagonis Serang Habis-habisan',
    channelName: 'VideoDracin Originals',
    category: 'drama',
    width: 1280,
    height: 720,
    folderName: 'Series-105',
    fileNames: [
      '1_subtitled.mp4',
      '2_subtitled.mp4',
      '3_subtitled.mp4',
      '4_subtitled.mp4',
      '5_subtitled.mp4',
      '6_subtitled.mp4',
      '7_subtitled.mp4',
      '8_subtitled.mp4',
      '9_subtitled.mp4',
      '10_subtitled.mp4',
    ],
    baseLikeCount: 60,
  }),
];
