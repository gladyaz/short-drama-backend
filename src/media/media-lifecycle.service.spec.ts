import { HttpStatus } from '@nestjs/common';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { MediaLifecycleService } from './media-lifecycle.service';
import { MediaLifecycleState } from './media-lifecycle.types';

const ALL_STATES = Object.values(MediaLifecycleState);

/** `[from, to]` pairs the approved runbook explicitly allows. */
const ALLOWED_EDGES: Array<[MediaLifecycleState, MediaLifecycleState]> = [
  [MediaLifecycleState.DRAFT, MediaLifecycleState.READY],
  [MediaLifecycleState.READY, MediaLifecycleState.PUBLISHED],
  [MediaLifecycleState.PUBLISHED, MediaLifecycleState.UNPUBLISHED],
  [MediaLifecycleState.UNPUBLISHED, MediaLifecycleState.PUBLISHED],
  [MediaLifecycleState.DRAFT, MediaLifecycleState.FAILED],
  [MediaLifecycleState.READY, MediaLifecycleState.FAILED],
  [MediaLifecycleState.PUBLISHED, MediaLifecycleState.FAILED],
  [MediaLifecycleState.UNPUBLISHED, MediaLifecycleState.FAILED],
];

function isAllowed(
  from: MediaLifecycleState,
  to: MediaLifecycleState,
): boolean {
  return ALLOWED_EDGES.some((edge) => edge[0] === from && edge[1] === to);
}

describe('MediaLifecycleService', () => {
  let service: MediaLifecycleService;

  beforeEach(() => {
    service = new MediaLifecycleService();
  });

  describe('isValidState', () => {
    it('recognizes every known lifecycle state', () => {
      for (const state of ALL_STATES) {
        expect(service.isValidState(state)).toBe(true);
      }
    });

    it('rejects an unknown string', () => {
      expect(service.isValidState('archived')).toBe(false);
      expect(service.isValidState('')).toBe(false);
      expect(service.isValidState('DRAFT')).toBe(false); // case-sensitive
    });
  });

  describe('canTransition / assertTransition with an unrecognized state', () => {
    it('canTransition returns false instead of throwing when `from` is not a known state', () => {
      expect(
        service.canTransition(
          'archived' as MediaLifecycleState,
          MediaLifecycleState.DRAFT,
        ),
      ).toBe(false);
    });

    it('assertTransition throws INVALID_MEDIA_LIFECYCLE_TRANSITION (not a raw TypeError) for an unrecognized `from`', () => {
      expect(() =>
        service.assertTransition(
          'archived' as MediaLifecycleState,
          MediaLifecycleState.DRAFT,
        ),
      ).toThrow(AppException);
    });
  });

  /**
   * Exhaustive coverage: every one of the 5x5 = 25 `(from, to)` pairs across
   * all lifecycle states is checked against the explicit `ALLOWED_EDGES`
   * table, so this suite fails immediately if `MEDIA_LIFECYCLE_TRANSITIONS`
   * ever silently drifts from the approved runbook
   * (`draft -> ready -> published <-> unpublished`, `* -> failed`, `failed`
   * terminal).
   */
  describe('canTransition (exhaustive over all state pairs)', () => {
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        const expected = isAllowed(from, to);

        it(`${from} -> ${to} is ${expected ? 'allowed' : 'rejected'}`, () => {
          expect(service.canTransition(from, to)).toBe(expected);
        });
      }
    }
  });

  describe('assertTransition', () => {
    it('returns the target state for every allowed edge', () => {
      for (const [from, to] of ALLOWED_EDGES) {
        expect(service.assertTransition(from, to)).toBe(to);
      }
    });

    it('throws a 400 AppException with INVALID_MEDIA_LIFECYCLE_TRANSITION for a disallowed edge', () => {
      let caught: unknown;
      try {
        service.assertTransition(
          MediaLifecycleState.DRAFT,
          MediaLifecycleState.PUBLISHED,
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AppException);
      const exception = caught as AppException;
      expect(exception.code).toBe(
        AppErrorCode.INVALID_MEDIA_LIFECYCLE_TRANSITION,
      );
      expect(exception.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects a same-state "transition" (not a no-op)', () => {
      for (const state of ALL_STATES) {
        expect(() => service.assertTransition(state, state)).toThrow(
          AppException,
        );
      }
    });

    it('rejects every transition attempted out of the terminal "failed" state', () => {
      for (const to of ALL_STATES) {
        expect(() =>
          service.assertTransition(MediaLifecycleState.FAILED, to),
        ).toThrow(AppException);
      }
    });

    it('rejects backward transitions (published -> ready, ready -> draft, etc.)', () => {
      expect(() =>
        service.assertTransition(
          MediaLifecycleState.PUBLISHED,
          MediaLifecycleState.READY,
        ),
      ).toThrow(AppException);
      expect(() =>
        service.assertTransition(
          MediaLifecycleState.READY,
          MediaLifecycleState.DRAFT,
        ),
      ).toThrow(AppException);
      expect(() =>
        service.assertTransition(
          MediaLifecycleState.UNPUBLISHED,
          MediaLifecycleState.DRAFT,
        ),
      ).toThrow(AppException);
    });

    it('rejects skipping a state (draft -> published directly)', () => {
      expect(() =>
        service.assertTransition(
          MediaLifecycleState.DRAFT,
          MediaLifecycleState.PUBLISHED,
        ),
      ).toThrow(AppException);
    });
  });
});
