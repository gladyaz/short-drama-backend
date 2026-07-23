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
