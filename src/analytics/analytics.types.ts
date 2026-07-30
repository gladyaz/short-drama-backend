/**
 * Phase 11, work unit 11-B3: the server-side event schema. This map is the
 * single source of truth for (a) which event names the ingestion endpoint
 * accepts at all and (b) which property keys survive into the database —
 * anything not listed here is stripped before persistence, enforcing the
 * "no PII beyond auth without a recorded decision" acceptance criterion at
 * the server boundary rather than trusting clients (see the workspace
 * DECISIONS.md, "Phase 11 approved...", default decision 4).
 */
export const EVENT_PROPERTY_ALLOWLIST: Record<string, readonly string[]> = {
  /** Home feed gained focus. No properties. */
  feed_view: [],
  /** A video became the active, playing feed item. */
  video_play: ['videoId', 'seriesId', 'episodeNumber'],
  /** Like toggled; `value` is the resulting state. */
  video_like: ['videoId', 'value'],
  /** Save toggled; `value` is the resulting state. */
  video_save: ['videoId', 'value'],
  /** User navigated to another episode (next-episode button or series detail). */
  episode_navigate: ['videoId', 'seriesId', 'episodeNumber', 'source'],
  /** The premium preview modal blocked a premium episode. */
  premium_gate_hit: ['videoId', 'seriesId', 'episodeNumber', 'source'],
  /**
   * Phase 11's self-hosted JS-level crash capture (DECISIONS.md default
   * decision 2): fatal JS errors / unhandled rejections from the mobile
   * app's global handlers. `stack`/`message` are truncated server-side.
   */
  app_error: ['message', 'stack', 'isFatal', 'source'],
};

export const KNOWN_EVENT_NAMES = Object.keys(EVENT_PROPERTY_ALLOWLIST);

export const KNOWN_PLATFORMS = ['ios', 'android', 'web'] as const;

/** Hard cap applied to every string property value before persistence. */
export const MAX_PROPERTY_STRING_LENGTH = 2000;

/** Maximum events accepted in a single ingestion batch. */
export const MAX_BATCH_SIZE = 50;

export interface IngestEventsResponseDto {
  accepted: number;
}

/**
 * Phase 12, work unit 12E-B2 (`DECISIONS.md` "Phase 12 decision-resolution
 * remediation slice (12E) approved..." entry, decision 2): re-applies
 * `EVENT_PROPERTY_ALLOWLIST` to an ALREADY-PERSISTED `AnalyticsEvent.properties`
 * value, for `GET /users/me/export` (`ExportService`, `export.types.ts`).
 *
 * Deliberately a SEPARATE function from `AnalyticsService.sanitizeProperties`
 * above, not a shared call site, even though the allowlist/truncation/
 * scalar-only logic is intentionally identical — that method's job is to
 * validate WRITE-time input (`Record<string, unknown> | undefined`, already
 * shaped by `AnalyticsEventInputDto`'s class-validator pipeline); this
 * function's job is to re-derive the same guarantee at READ time, directly
 * from whatever is actually sitting in the database column today (typed as
 * `unknown` here because Prisma's `Json` column type can, in principle, hold
 * any JSON shape, not just the object this codebase always writes). This is
 * DEFENCE IN DEPTH, not redundant belt-and-suspenders: the write-time scrub
 * only reflects the allowlist as it existed AT THE TIME a given row was
 * inserted — it cannot retroactively fix a row written under a past or
 * future version of `EVENT_PROPERTY_ALLOWLIST` (a key added, renamed, or
 * removed for a given `eventName`). Re-deriving the filter from the CURRENT
 * allowlist on every read closes that gap regardless of a row's age, which
 * is exactly what a personal-data export needs (see `export.types.ts`'s
 * `AnalyticsEvent` section for the full reasoning).
 */
export function filterEventPropertiesForExport(
  eventName: string,
  properties: unknown,
): Record<string, string | number | boolean> {
  const filtered: Record<string, string | number | boolean> = {};

  if (
    properties === null ||
    properties === undefined ||
    typeof properties !== 'object' ||
    Array.isArray(properties)
  ) {
    return filtered;
  }

  const source = properties as Record<string, unknown>;

  for (const key of EVENT_PROPERTY_ALLOWLIST[eventName] ?? []) {
    const value = source[key];

    if (typeof value === 'string') {
      filtered[key] = value.slice(0, MAX_PROPERTY_STRING_LENGTH);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      filtered[key] = value;
    } else if (typeof value === 'boolean') {
      filtered[key] = value;
    }
  }

  return filtered;
}
