/**
 * Phase 11, work unit 11B-3: the admin-facing view of a `Video` row —
 * unlike `VideoResponseDto` (the public feed shape, `video.types.ts`),
 * this exposes the object-storage keys and `lifecycleState` an admin needs
 * to track an upload through the pipeline, and never computes a
 * `playbackUrl` (a draft/ready row has no guaranteed streamable file yet).
 */
export interface AdminMediaDto {
  id: string;
  seriesId: string;
  title: string;
  episodeNumber: number;
  channelName: string;
  caption: string;
  category: string;
  sourceLanguage: string;
  hasEmbeddedIndonesianSubtitle: boolean;
  lifecycleState: string;
  objectStorageKey: string | null;
  objectStorageVariant: string | null;
  coverImageKey: string | null;
  thumbnailImageKey: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
}

export interface PresignedUploadDto {
  url: string;
  key: string;
  expiresAt: string;
}

export interface CreateMediaUploadResponseDto {
  media: AdminMediaDto;
  upload: PresignedUploadDto;
}

export interface MediaAssetUploadResponseDto {
  media: AdminMediaDto;
  upload: PresignedUploadDto;
}
