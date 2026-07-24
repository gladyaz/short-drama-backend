import { HttpStatus, Injectable } from '@nestjs/common';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { MEDIA_LIFECYCLE_TRANSITIONS } from './media-lifecycle.constants';
import { MediaLifecycleState } from './media-lifecycle.types';

const VALID_STATES = new Set<string>(Object.values(MediaLifecycleState));

/**
 * Phase 11, work unit 11B-1: validates media lifecycle transitions
 * (`draft -> ready -> published <-> unpublished`, `* -> failed`). Pure
 * validation only — this service never reads or writes a `Video` row
 * itself; callers (11B-3's admin media API) are responsible for the actual
 * Prisma update once a transition is confirmed valid.
 */
@Injectable()
export class MediaLifecycleService {
  /** Narrows an arbitrary string (e.g. read from the DB) to a known state. */
  isValidState(value: string): value is MediaLifecycleState {
    return VALID_STATES.has(value);
  }

  /**
   * Defensively re-validates `from`/`to` against the known state set (Phase
   * 11, work unit 11B-3 needs this: `from` is read back off a `Video` row's
   * plain-`String` `lifecycleState` column, not something the type system
   * can already guarantee is one of the five known values) — an unknown
   * value on either side is always "cannot transition", never a thrown
   * `TypeError` from indexing `MEDIA_LIFECYCLE_TRANSITIONS` with an unknown
   * key.
   */
  canTransition(from: MediaLifecycleState, to: MediaLifecycleState): boolean {
    if (!this.isValidState(from) || !this.isValidState(to)) {
      return false;
    }

    return MEDIA_LIFECYCLE_TRANSITIONS[from].includes(to);
  }

  /**
   * Validates `from -> to` and returns `to` on success. Throws a clean 400
   * `AppException` (`INVALID_MEDIA_LIFECYCLE_TRANSITION`) for any
   * disallowed edge, including a same-state "transition" (e.g.
   * `draft -> draft`) and any transition attempted out of the terminal
   * `failed` state.
   */
  assertTransition(
    from: MediaLifecycleState,
    to: MediaLifecycleState,
  ): MediaLifecycleState {
    if (!this.canTransition(from, to)) {
      throw new AppException(
        AppErrorCode.INVALID_MEDIA_LIFECYCLE_TRANSITION,
        `Cannot transition media lifecycle from "${from}" to "${to}"`,
        HttpStatus.BAD_REQUEST,
      );
    }

    return to;
  }
}
