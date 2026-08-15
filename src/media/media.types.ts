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
  /**
   * Work unit 11E-3: the raw per-episode access-tier override, exposed here
   * (the admin-only DTO) and deliberately NOT on the public
   * `VideoResponseDto` in `../videos/video.types.ts` — the public feed shape
   * is unchanged by this work unit. `null` means "no override, use the
   * default `episodeNumber > FREE_EPISODE_LIMIT` rule".
   */
  accessTierOverride: 'free' | 'premium' | null;
  /**
   * Work unit "Episode Access-Tier + Category Contract Hardening":
   * ADDITIVE — the same resolved (effective) tier the public
   * `VideoResponseDto.accessTier` field exposes, computed via the same
   * authoritative `resolveAccessTier` function. Lets an admin see, next to
   * the raw `accessTierOverride`, exactly what the public catalog currently
   * reports for this episode — always in agreement by construction, never a
   * second/duplicated derivation.
   */
  accessTier: 'free' | 'premium';
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

/**
 * Response of `GET /admin/media` (work unit 11E-1): a paginated slice of
 * the admin inventory, across ALL lifecycle states (draft/ready/published/
 * unpublished/failed) — unlike the public feed, which only ever returns
 * `published` rows.
 */
export interface AdminMediaListResponseDto {
  items: AdminMediaDto[];
  total: number;
  page: number;
  pageSize: number;
}
