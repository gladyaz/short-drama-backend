import type { ThrottlerStorageService } from '@nestjs/throttler';

/**
 * Safe replacement for the bare `throttlerStorage.storage.clear()` the e2e
 * specs previously used to reset rate-limit state between tests/iterations.
 *
 * `@nestjs/throttler`'s in-memory `ThrottlerStorageService` schedules one
 * `setTimeout` per counted hit (`setExpirationTime`) whose callback
 * destructures `this.storage.get(key)` WITHOUT a missing-record guard.
 * Clearing the storage map while any of those TTL timers is still pending
 * makes the callback destructure `undefined` and throw (`TypeError: Cannot
 * destructure property 'totalHits' ...`) in a bare timer context — Jest
 * attributes that crash to whichever test happens to be running at the
 * moment the timer fires. Observed in the wild exactly once across three
 * consecutive full e2e runs of the final reconciliation gate, in
 * `account-deletion-concurrency.e2e-spec.ts` (the most aggressive clearer:
 * per-iteration inside 30-iteration hammer loops), but every spec that
 * cleared the map bare carried the same hazard.
 *
 * The fix mirrors the library's own `onApplicationShutdown` exactly: cancel
 * every tracked pending timer FIRST, then clear both maps. Nothing may ever
 * `await` between those steps — the function is synchronous precisely so a
 * timer cannot fire mid-reset.
 *
 * `timeoutIds` is `private` in the library's typings, so this helper is the
 * ONE sanctioned place that reaches it, via a structural cast kept in sync
 * with `@nestjs/throttler`'s implementation (verified against v6.5.0, where
 * `timeoutIds` is a `Map<throttlerName, Timeout[]>`). Test-only by
 * construction: this file lives under `src/common/testing/`, which
 * `tsconfig.build.json` excludes from the production build.
 */
export function resetThrottlerStorage(
  throttlerStorage: ThrottlerStorageService,
): void {
  const internals = throttlerStorage as unknown as {
    timeoutIds: Map<string, NodeJS.Timeout[]>;
  };
  internals.timeoutIds.forEach((timeouts) =>
    timeouts.forEach((timeoutId) => clearTimeout(timeoutId)),
  );
  internals.timeoutIds.clear();
  throttlerStorage.storage.clear();
}
