/**
 * Slice 11Q — Content-Type resolution by file extension only (never by
 * sniffing bytes, never by trusting a client-supplied header). Matches the
 * exact same media-type mapping the backend's local HLS pipeline already
 * uses (`short-drama-backend/src/transcode/hls/hls.constants.ts`'s
 * `HLS_PLAYLIST_CONTENT_TYPE`/`HLS_INIT_SEGMENT_CONTENT_TYPE`/
 * `HLS_MEDIA_SEGMENT_CONTENT_TYPE`), duplicated here (not imported) since
 * this package is a fully independent npm package with no dependency on
 * the parent backend's `node_modules`/build.
 */
const OCTET_STREAM = 'application/octet-stream';

export function resolveContentType(pathOrFilename: string): string {
  const lower = pathOrFilename.toLowerCase();

  if (lower.endsWith('.m3u8')) {
    return 'application/vnd.apple.mpegurl';
  }
  // `init.mp4` is a plain `.mp4`-suffixed file — the general `.mp4` check
  // below already covers it; no special-case is needed.
  if (lower.endsWith('.mp4')) {
    return 'video/mp4';
  }
  if (lower.endsWith('.m4s')) {
    return 'video/iso.segment';
  }
  if (lower.endsWith('.jpg')) {
    return 'image/jpeg';
  }

  return OCTET_STREAM;
}
