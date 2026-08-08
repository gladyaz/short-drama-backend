import { HttpStatus } from '@nestjs/common';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';

/**
 * The only two `Video` columns `resolvePlaybackSource` reads. Deliberately
 * narrow (not the full Prisma row / `VideoRecord`) so callers cannot
 * accidentally pass request-supplied data into this decision — it always
 * comes from a `Video` row already loaded from the database.
 */
export interface PlaybackSourceRecord {
  /** Local `STORAGE_ROOT`-relative path. `''` means "not set" (see `videos.service.ts`'s `findAll` OR-filter comment for the same convention). */
  storageKey: string;
  /** Cloudflare R2 object key, populated only via the 11B-3 admin upload pipeline. `null`/`''` means "not set". */
  objectStorageKey: string | null;
}

export type PlaybackSource =
  { kind: 'r2'; objectStorageKey: string } | { kind: 'local' };

/**
 * Phase 11, work unit 11M-B1: the SINGLE place that decides whether a
 * `Video` row's playable bytes live in Cloudflare R2 (`objectStorageKey`) or
 * on the local `STORAGE_ROOT` filesystem (`storageKey`). Every caller that
 * needs this decision — today, `VideosService.getPlaybackUrl` — MUST go
 * through this function rather than re-deriving the rule inline, so the
 * "which source wins" policy exists in exactly one place.
 *
 * Rule: `objectStorageKey` non-empty -> R2. Otherwise `storageKey`
 * non-empty -> local. Otherwise -> fail closed (throws).
 *
 * Precedence when BOTH are set: R2 wins. `objectStorageKey` is populated
 * ONLY through a deliberate admin action (`AdminMediaService.createUpload`
 * completing an R2 upload) — its mere presence is evidence of a newer,
 * intentional decision to serve this row from R2, whereas `storageKey` is
 * the original column every pre-11A-2 row already carries and that a
 * legacy/local-fixture row may still carry incidentally alongside a newer
 * R2 upload. Slice 11M's entire purpose is routing already-published R2
 * media to a direct-to-R2 playback path, so preferring R2 whenever it is
 * genuinely present is also the only reading consistent with that goal.
 *
 * Fails CLOSED (throws `AppException(MEDIA_PLAYBACK_SOURCE_UNAVAILABLE)`,
 * never returns a "no source" value) when NEITHER column is a non-empty
 * string. This can only be reached for a row `VideosService.findAll`'s own
 * OR filter already treats as "not really playable" in the public feed, but
 * that filter does not protect `GET /videos/:id/playback` (which is looked
 * up directly by id) — this function is that endpoint's own, independent
 * fail-closed guard, so a broken row never reaches
 * `StorageService.createPresignedGetUrl` with an empty key or the stream
 * endpoint's filesystem check with an empty path.
 */
export function resolvePlaybackSource(
  record: PlaybackSourceRecord,
): PlaybackSource {
  if (record.objectStorageKey && record.objectStorageKey.length > 0) {
    return { kind: 'r2', objectStorageKey: record.objectStorageKey };
  }

  if (record.storageKey && record.storageKey.length > 0) {
    return { kind: 'local' };
  }

  throw new AppException(
    AppErrorCode.MEDIA_PLAYBACK_SOURCE_UNAVAILABLE,
    'This video has no playable storage source configured',
    HttpStatus.CONFLICT,
  );
}
