/**
 * Slice 11P — Production Transcoding Lifecycle (control workspace
 * DECISIONS.md "2026-08-10 — Slice 11P APPROVED..." entry; architecture:
 * `proposals/phase-11-hls-pipeline-proposal.md` §5, §7-§8). Pure,
 * unit-testable key-layout helpers for the versioned/immutable HLS staging
 * tree under `admin-media/<mediaId>/hls/` — mirroring
 * `../media/media-storage-key.util.ts`'s existing precedent (deterministic
 * key builders, no I/O, no Nest DI) for the `source`/`cover`/`thumbnail`
 * keys that namespace already establishes.
 *
 * Extends the existing, proven layout (proposal §5):
 *
 * ```
 * admin-media/<mediaId>/
 *   source                      (exists — original MP4)
 *   cover                       (exists)
 *   thumbnail                   (exists — poster)
 *   hls/v<processingVersion>-a<attempt>-<uuid>/
 *     master.m3u8
 *     360p/init.mp4 index.m3u8 seg_00001.m4s …
 * ```
 *
 * Every generation prefix is unique (a fresh `randomUUID()` per attempt, on
 * top of `v<version>-a<attempt>`, so even a RETRY of the exact same
 * `(videoId, processingVersion, attempt)` triple — which cannot happen
 * today, since `processingAttempts` only ever increases, but is defended
 * against anyway — could never collide with a previous attempt's own
 * objects) — this is what "fresh immutable prefix per retry" (proof 6) and
 * "never overwrite the live/active generation" (proof 11) are built on.
 */

/** The fixed sub-namespace every HLS generation lives under, for one media id. */
export function buildHlsHomePrefix(mediaId: string): string {
  return `admin-media/${mediaId}/hls/`;
}

/**
 * One transcode ATTEMPT's own immutable, uniquely-named staging prefix.
 * `attempt` is `Video.processingAttempts`' post-claim value (1-based, set by
 * `TranscodeIntentService.claimRunning`); `uuid` is caller-supplied (always a
 * fresh `randomUUID()` from `TranscodeJobProcessor`, never generated here) so
 * this function stays pure and its output is directly assertable in tests.
 */
export function buildHlsStagingPrefix(
  mediaId: string,
  processingVersion: number,
  attempt: number,
  uuid: string,
): string {
  return `${buildHlsHomePrefix(mediaId)}v${processingVersion}-a${attempt}-${uuid}/`;
}

export function buildHlsMasterPlaylistKey(stagingPrefix: string): string {
  return `${stagingPrefix}master.m3u8`;
}

/**
 * Derives the OWNING generation prefix (e.g.
 * `"admin-media/x/hls/v3-a1-uuid/"`) from a full `hlsMasterKey` value (e.g.
 * `"admin-media/x/hls/v3-a1-uuid/master.m3u8"`) — i.e. everything up to and
 * including the final `/` before the filename. Returns `null` for a
 * `null`/malformed input (never throws) so callers (`TranscodeJanitorService`
 * — see its "never delete the active generation" invariant) can treat "no
 * active generation yet" and "couldn't parse the pointer" identically: both
 * mean there is no prefix to protect from THIS row's own pointer, which is
 * the SAFE default (the caller still never deletes anything except objects
 * it can positively prove are old/orphaned via the age check).
 */
export function deriveActiveGenerationPrefix(
  hlsMasterKey: string | null | undefined,
): string | null {
  if (!hlsMasterKey) {
    return null;
  }

  const lastSlashIndex = hlsMasterKey.lastIndexOf('/');
  if (lastSlashIndex < 0) {
    return null;
  }

  return hlsMasterKey.slice(0, lastSlashIndex + 1);
}

/**
 * Groups a flat list of object keys (as returned by
 * `StorageService.listObjectKeysByPrefix`, all sharing the `hls/` home
 * prefix for one media id) by their immediate GENERATION prefix — i.e. the
 * `v<n>-a<n>-<uuid>/` path segment directly under `hls/`. A key that does not
 * fit that shape (should never happen for objects this pipeline itself
 * wrote, but defended against rather than assumed) is silently excluded, not
 * thrown on — this is a best-effort grouping for a bounded janitor sweep, not
 * a correctness-critical parser.
 */
export function groupKeysByGenerationPrefix(
  homePrefix: string,
  keys: readonly string[],
): Map<string, string[]> {
  const groups = new Map<string, string[]>();

  for (const key of keys) {
    if (!key.startsWith(homePrefix)) {
      continue;
    }

    const rest = key.slice(homePrefix.length);
    const firstSlashIndex = rest.indexOf('/');
    if (firstSlashIndex < 0) {
      continue;
    }

    const generationPrefix = `${homePrefix}${rest.slice(0, firstSlashIndex + 1)}`;
    const existing = groups.get(generationPrefix);
    if (existing) {
      existing.push(key);
    } else {
      groups.set(generationPrefix, [key]);
    }
  }

  return groups;
}
