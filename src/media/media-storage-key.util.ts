/**
 * Phase 11, work unit 11B-3: deterministic object-storage key layout for
 * admin-uploaded media, namespaced under `admin-media/` to keep it clearly
 * separate from any future 11D-1 bulk-import key convention.
 */
export function buildSourceObjectKey(mediaId: string): string {
  return `admin-media/${mediaId}/source`;
}

export function buildCoverObjectKey(mediaId: string): string {
  return `admin-media/${mediaId}/cover`;
}

export function buildThumbnailObjectKey(mediaId: string): string {
  return `admin-media/${mediaId}/thumbnail`;
}
