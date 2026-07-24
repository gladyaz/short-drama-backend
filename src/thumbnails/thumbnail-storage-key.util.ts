/**
 * Phase 11, work unit 11D-2b: deterministic object-storage key for a
 * generated thumbnail, mirroring `../media/media-storage-key.util.ts`'s
 * pattern but namespaced separately under `thumbnails/` — distinct from
 * 11B-3's `admin-media/{id}/thumbnail` manual-asset-upload key, since this
 * is the ffmpeg-generation pipeline (11D-2), not the admin manual-upload
 * flow. The same `(assetId, variant)` pair always produces the same key —
 * no timestamp, uuid, or other randomness in the key itself — so
 * re-generating the same variant overwrites the same object instead of
 * accumulating orphaned objects in the bucket.
 */
export function buildThumbnailStorageKey(
  assetId: string,
  variant: string,
): string {
  return `thumbnails/${assetId}/${variant}.jpg`;
}
