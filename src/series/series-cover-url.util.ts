import { StorageDriver } from '../config/configuration';
import { DEFAULT_GET_URL_EXPIRY_SECONDS } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';

/**
 * Work unit "SERIES COVER UPLOAD BACKEND CONTRACT": the single, shared
 * `Series.coverImageKey` -> `coverUrl` transform, EXTRACTED from
 * `PublicSeriesService`'s original private `resolveCoverUrl` method (work
 * unit "SERIES METADATA + DISCOVER ARTWORK CONTRACT") so the admin-guarded
 * read surface (`SeriesService.list`/`findById`/`completeCoverUpload`,
 * acceptance criterion 5) can reuse the EXACT same mechanism instead of a
 * second, drift-prone copy.
 *
 * Work unit "LOCAL SERIES COVER ARTWORK": that transform is now driver-aware,
 * because the two drivers serve artwork by genuinely different mechanisms and
 * the previous single answer was only ever correct for one of them.
 */

/**
 * The deployment facts this transform needs, read once by each calling
 * service from its own `ConfigService` rather than re-read per row.
 */
export interface SeriesCoverUrlContext {
  readonly driver: StorageDriver;
  /** `PUBLIC_BASE_URL` — the origin a client can actually reach this API on. */
  readonly publicBaseUrl: string;
}

/**
 * The `coverUrl` for one series, or `null` when it genuinely has no artwork.
 *
 * `r2` (production): a presigned GET, minted fresh per request and never
 * persisted — unchanged, byte for byte, from before this work unit. Mirrors
 * `VideosService.getPlaybackUrl`'s established pattern.
 * `DEFAULT_GET_URL_EXPIRY_SECONDS` (1 hour), not the video-specific
 * `PLAYBACK_URL_EXPIRY_SECONDS` — a cover image is a generic, cacheable
 * display asset with no playback-authorization semantics.
 *
 * `local`: an absolute URL to this API's own `GET /series/:id/cover` route,
 * which streams the bytes out of `StorageConfig.localRoot`.
 *
 * WHY THE LOCAL BRANCH IS NOT A PRESIGNED URL. Under the `local` driver
 * `StorageModule` builds its `S3Client` from empty endpoint/region/credential
 * strings. `getSignedUrl` does not reject that — it returns a
 * well-formed-looking URL for a bucket that does not exist. The failure
 * therefore lands on the CLIENT as an image that silently never loads, with a
 * URL that looks correct in every log. Returning this API's own route instead
 * is the difference between artwork that works locally and artwork that only
 * appears to have been configured.
 *
 * WHY THE ROUTE, NOT THE KEY, IS IN THE URL. `coverUrl` is consumed by the
 * app as an opaque absolute URL (`<Image source={{ uri }}>`), so nothing
 * downstream needs the key — and keeping the key server-side means the only
 * client-supplied value on the cover route is a series id used for a
 * parameterised database lookup. There is no client-controlled path segment
 * to traverse with. This also keeps `coverUrl` stable across the two drivers'
 * very different key/URL shapes: one contract, two implementations.
 */
export async function resolveSeriesCoverUrl(
  storageService: StorageService,
  context: SeriesCoverUrlContext,
  series: { readonly id: string; readonly coverImageKey: string | null },
): Promise<string | null> {
  if (!series.coverImageKey) {
    return null;
  }

  if (context.driver === 'local') {
    return buildLocalSeriesCoverUrl(context.publicBaseUrl, series.id);
  }

  const signed = await storageService.createPresignedGetUrl(
    series.coverImageKey,
    { expiresInSeconds: DEFAULT_GET_URL_EXPIRY_SECONDS },
  );

  return signed.url;
}

/**
 * The absolute URL of `GET /series/:id/cover` for `seriesId`.
 *
 * `encodeURIComponent`, for the same reason `buildSeriesCoverObjectKeyPrefix`
 * uses it: `Series.id` is CLIENT-PROVIDED at create time (`CreateSeriesDto.id`
 * constrains length only), so an id containing `/`, `?` or `#` would
 * otherwise change the shape of the URL it is interpolated into rather than
 * being carried by it. The trailing-slash normalisation mirrors
 * `StorageService.buildPublicUrl`.
 */
export function buildLocalSeriesCoverUrl(
  publicBaseUrl: string,
  seriesId: string,
): string {
  const base = publicBaseUrl.replace(/\/+$/, '');

  return `${base}/series/${encodeURIComponent(seriesId)}/cover`;
}
