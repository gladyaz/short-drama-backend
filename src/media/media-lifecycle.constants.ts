import { MediaLifecycleState } from './media-lifecycle.types';

/**
 * Phase 11, work unit 11B-1: the allowed edges of the media lifecycle state
 * machine, per the approved runbook —
 * `draft -> ready -> published <-> unpublished`, and `* -> failed` from any
 * state. `FAILED` is deliberately terminal (no outgoing edges): recovering
 * a failed upload/import is a new `draft` created by the caller (11B-3/
 * 11D-1), not a transition out of `failed` on the same record — keeping the
 * state machine simple (YAGNI) until a real "retry in place" requirement
 * appears.
 */
export const MEDIA_LIFECYCLE_TRANSITIONS: Readonly<
  Record<MediaLifecycleState, ReadonlyArray<MediaLifecycleState>>
> = {
  [MediaLifecycleState.DRAFT]: [
    MediaLifecycleState.READY,
    MediaLifecycleState.FAILED,
  ],
  [MediaLifecycleState.READY]: [
    MediaLifecycleState.PUBLISHED,
    MediaLifecycleState.FAILED,
  ],
  [MediaLifecycleState.PUBLISHED]: [
    MediaLifecycleState.UNPUBLISHED,
    MediaLifecycleState.FAILED,
  ],
  [MediaLifecycleState.UNPUBLISHED]: [
    MediaLifecycleState.PUBLISHED,
    MediaLifecycleState.FAILED,
  ],
  [MediaLifecycleState.FAILED]: [],
};
