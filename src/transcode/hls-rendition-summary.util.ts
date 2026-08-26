import { HlsRenditionSummary } from './transcode.types';

/**
 * `Video.hlsRenditions` is a Prisma `Json?` column — at the type level it
 * comes back as `Prisma.JsonValue` (effectively `unknown` here), which could
 * in principle be `null`, a non-array value, or an array containing malformed
 * entries if ever hand-edited. This is a defensive, non-throwing parser:
 * anything that is not EXACTLY an array of well-formed
 * `HlsRenditionSummary`-shaped objects is filtered out (an entirely malformed
 * value yields an empty array, never a thrown error and never a
 * partially-trusted entry) — no reader ever trusts this column's shape
 * implicitly, even though the ONLY writer today
 * (`TranscodeIntentService.promoteIfCurrent`, Slice 11P) always writes a
 * well-formed array.
 *
 * Extracted from `VideosService` (where it was a private module-level
 * function) by the "HLS DEMOTE" work unit, byte-for-byte unchanged, because
 * `HlsDemoteService` needs the exact same defensive read to report which
 * renditions would stop being advertised. Two independently-written parsers
 * of the same column could drift; one shared parser cannot.
 */
export function parseHlsRenditions(value: unknown): HlsRenditionSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isHlsRenditionSummary);
}

function isHlsRenditionSummary(value: unknown): value is HlsRenditionSummary {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === 'string' &&
    candidate.name.length > 0 &&
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number' &&
    typeof candidate.bandwidth === 'number'
  );
}
