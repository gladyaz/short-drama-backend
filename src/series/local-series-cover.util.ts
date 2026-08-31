import { resolve, sep } from 'path';
import { AllowedSeriesCoverContentType } from './series-cover.constants';

/**
 * Work unit "LOCAL SERIES COVER ARTWORK": the filesystem half of the `local`
 * storage driver's cover surface — turning a `Series.coverImageKey` into a
 * readable absolute path, and deciding what `Content-Type` the bytes at that
 * path may be served as.
 *
 * WHY THIS EXISTS AT ALL. `resolveSeriesCoverUrl` mints a presigned R2 GET
 * for `driver === 'r2'`, which is the whole cover-serving mechanism in
 * production. Under `driver === 'local'` there is no bucket to presign
 * against — `StorageModule` still constructs an `S3Client`, but from empty
 * endpoint/region/credential strings, so a presign there would not fail
 * loudly, it would silently hand the client a syntactically valid URL
 * pointing at nothing. This module is the local driver's honest answer to
 * the same question instead.
 */

/** Bytes to read off the head of a cover file to identify its format. */
export const COVER_MAGIC_BYTE_LENGTH = 12;

/**
 * Resolves an object KEY against the local object root and refuses any result
 * that escapes it — the same defence, and the same reasoning,
 * `videos/storage-path.util.ts::resolveSafeStoragePath` applies to
 * `STORAGE_ROOT`, kept as its own function here because the two roots are
 * deliberately different directories (see `StorageConfig.localRoot`) and a
 * shared helper would invite passing the wrong one.
 *
 * Returns `null` rather than throwing: every caller is answering a PUBLIC,
 * unauthenticated request, and "this key does not resolve to a servable file"
 * and "this series has no cover" must be indistinguishable on the wire. A
 * thrown, differently-shaped error would let a caller probe which keys exist.
 *
 * The root itself is never a valid result — an empty key resolves to the root
 * directory, which is not a file to serve.
 *
 * This is the SECOND of two independent guards, not the only one. The first
 * is structural: `SeriesPublicController#getCover` only ever serves a key
 * that `isValidSeriesCoverObjectKey` accepts, and that shape —
 * `admin-series/<encodeURIComponent(id)>/cover/<uuid v4>` — contains no path
 * separator or dot segment anywhere a caller can influence. A traversal would
 * have to survive both.
 */
export function resolveLocalCoverPath(
  localRoot: string,
  key: string,
): string | null {
  const resolvedRoot = resolve(localRoot);
  const resolvedPath = resolve(resolvedRoot, key);

  const isInsideRoot = resolvedPath.startsWith(resolvedRoot + sep);

  return isInsideRoot ? resolvedPath : null;
}

/**
 * The `Content-Type` for a cover file, decided from its OWN LEADING BYTES.
 *
 * WHY SNIFFING, NOT AN EXTENSION OR A COLUMN. A cover key ends in a bare
 * UUID with no extension (`isValidSeriesCoverObjectKey` requires exactly
 * that), and `Series` has no column recording the uploaded MIME type — under
 * `r2` it never needed one, because R2 stores and replays the `Content-Type`
 * declared at PUT time. Adding a column to carry it would be a migration in
 * service of the local driver alone.
 *
 * Sniffing is also the stricter choice. The returned type is drawn from
 * `ALLOWED_SERIES_COVER_CONTENT_TYPES` — the SAME closed allow-list the
 * upload contract enforces — so bytes that are not one of those three real
 * image formats get `null` and are never served at all, whatever the file is
 * named. That is what makes `X-Content-Type-Options: nosniff` (set globally
 * by `helmet()`) a guarantee rather than a hope: the declared type is derived
 * from the content, so the browser refusing to second-guess it is correct.
 *
 * `image/svg+xml` is absent here for the reason `series-cover.constants.ts`
 * gives — an SVG is a script-execution surface — and no amount of valid-
 * looking XML at the head of a file can produce it from this function.
 */
export function sniffSeriesCoverContentType(
  header: Buffer,
): AllowedSeriesCoverContentType | null {
  if (isJpeg(header)) {
    return 'image/jpeg';
  }

  if (isPng(header)) {
    return 'image/png';
  }

  if (isWebp(header)) {
    return 'image/webp';
  }

  return null;
}

/** SOI marker + the first byte of the following marker. */
function isJpeg(header: Buffer): boolean {
  return (
    header.length >= 3 &&
    header[0] === 0xff &&
    header[1] === 0xd8 &&
    header[2] === 0xff
  );
}

/** The 8-byte PNG signature from the PNG spec, in full. */
function isPng(header: Buffer): boolean {
  return (
    header.length >= 8 &&
    header
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  );
}

/**
 * A RIFF container whose form type is `WEBP`. BOTH markers are required: the
 * `RIFF` magic alone also matches WAV and AVI, which are not images and must
 * not be served as one.
 */
function isWebp(header: Buffer): boolean {
  return (
    header.length >= COVER_MAGIC_BYTE_LENGTH &&
    header.subarray(0, 4).toString('latin1') === 'RIFF' &&
    header.subarray(8, 12).toString('latin1') === 'WEBP'
  );
}
