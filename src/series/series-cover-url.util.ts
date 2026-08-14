import { DEFAULT_GET_URL_EXPIRY_SECONDS } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';

/**
 * Work unit "SERIES COVER UPLOAD BACKEND CONTRACT": the single, shared
 * `Series.coverImageKey` -> signed `coverUrl` transform, EXTRACTED from
 * `PublicSeriesService`'s original private `resolveCoverUrl` method (work
 * unit "SERIES METADATA + DISCOVER ARTWORK CONTRACT") so the admin-guarded
 * read surface (`SeriesService.list`/`findById`/`completeCoverUpload`,
 * acceptance criterion 5) can reuse the EXACT same mechanism instead of a
 * second, drift-prone copy. Mirrors `VideosService.getPlaybackUrl`'s
 * established R2 pattern: a presigned GET, minted fresh per request, never
 * persisted. `DEFAULT_GET_URL_EXPIRY_SECONDS` (1 hour), not the
 * video-specific `PLAYBACK_URL_EXPIRY_SECONDS` — a cover image is a
 * generic, cacheable display asset with no playback-authorization
 * semantics, unlike a video's `playbackUrl`.
 */
export async function resolveSeriesCoverUrl(
  storageService: StorageService,
  coverImageKey: string | null,
): Promise<string | null> {
  if (!coverImageKey) {
    return null;
  }

  const signed = await storageService.createPresignedGetUrl(coverImageKey, {
    expiresInSeconds: DEFAULT_GET_URL_EXPIRY_SECONDS,
  });

  return signed.url;
}
