/**
 * Phase 11, work unit 11B-1: the media lifecycle state machine that governs
 * `Video.lifecycleState` (added in 11A-2). Mirrors the DB column's plain
 * `String` type at rest (see the 11A-2 schema comment for why it is a
 * string, not a Postgres enum), but every value that actually flows through
 * `MediaLifecycleService` is one of these five states.
 */
export enum MediaLifecycleState {
  DRAFT = 'draft',
  READY = 'ready',
  PUBLISHED = 'published',
  UNPUBLISHED = 'unpublished',
  FAILED = 'failed',
}
