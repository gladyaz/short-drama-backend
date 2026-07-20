export interface VideoRecord {
  id: string;
  seriesId: string;
  title: string;
  episodeNumber: number;
  channelName: string;
  caption: string;
  category: string;
  /** Path relative to STORAGE_ROOT. Never an absolute filesystem path. */
  storageKey: string;
  sourceLanguage: string;
  hasEmbeddedIndonesianSubtitle: boolean;
  likeCount: number;
  durationSeconds?: number;
  /** Pixel dimensions measured with ffprobe against the real source file. */
  width?: number;
  height?: number;
}

export interface VideoResponseDto {
  id: string;
  seriesId: string;
  title: string;
  episodeNumber: number;
  channelName: string;
  caption: string;
  category: string;
  storageKey: string;
  playbackUrl: string;
  thumbnailUrl?: string;
  sourceLanguage: string;
  hasEmbeddedIndonesianSubtitle: boolean;
  likeCount: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
}
