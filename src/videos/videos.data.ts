import { VideoRecord } from './video.types';

/**
 * Hardcoded metadata for the Phase 5A POC. storageKey values are relative to
 * STORAGE_ROOT and were verified to point at real, playable company MP4 files
 * during read-only inspection of the storage folder.
 */
export const VIDEOS: VideoRecord[] = [
  {
    id: 'video-001',
    seriesId: 'series-001',
    title: 'Bintang Sekolah di Malam Hujan - Episode 1',
    episodeNumber: 1,
    channelName: 'VideoDracin Originals',
    caption: 'Seorang siswi pindahan misterius mengguncang seluruh kampus.',
    category: 'romance',
    storageKey: '短剧下载/10-雨夜校花（34集）/01.mp4',
    sourceLanguage: 'zh',
    hasEmbeddedIndonesianSubtitle: true,
    likeCount: 128,
  },
  {
    id: 'video-002',
    seriesId: 'series-001',
    title: 'Bintang Sekolah di Malam Hujan - Episode 2',
    episodeNumber: 2,
    channelName: 'VideoDracin Originals',
    caption: 'Rahasia masa lalu mulai terungkap saat hujan turun lagi.',
    category: 'romance',
    storageKey: '短剧下载/10-雨夜校花（34集）/02.mp4',
    sourceLanguage: 'zh',
    hasEmbeddedIndonesianSubtitle: true,
    likeCount: 94,
  },
  {
    id: 'video-003',
    seriesId: 'series-001',
    title: 'Bintang Sekolah di Malam Hujan - Episode 3',
    episodeNumber: 3,
    channelName: 'VideoDracin Originals',
    caption: 'Konflik antar geng sekolah memuncak di malam ujian.',
    category: 'romance',
    storageKey: '短剧下载/10-雨夜校花（34集）/03.mp4',
    sourceLanguage: 'zh',
    hasEmbeddedIndonesianSubtitle: true,
    likeCount: 76,
  },
];
