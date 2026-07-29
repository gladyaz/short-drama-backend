/** Milliseconds in one day. Named to avoid a magic-number `86400000`/`24 * 60 * 60 * 1000` inline. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Phase 12, work unit 12D-B1: computes a retention cutoff at DAY granularity,
 * not raw millisecond/hour precision — see `retention.constants.ts`'s file
 * doc comment for the full reasoning (the binding bound inherited from
 * 12D-B0: `Session.revokedAt` can read up to +7 hours later than reality for
 * any row revoked via a pre-`642a3af` `changePassword` call, and affected
 * rows are not distinguishable from correct ones).
 *
 * Truncates `now` to the start of ITS OWN UTC calendar day, then subtracts
 * `days` whole days. Two deliberate properties this buys:
 *
 *   1. The cutoff itself always lands exactly on a UTC midnight boundary,
 *      so comparing against it is insensitive to sub-day noise (including,
 *      but not limited to, the up-to-7-hour `revokedAt` skew above) — that
 *      noise can only ever matter within a few hours of the exact boundary,
 *      and because the skew is one-directional (a stored value only ever
 *      reads LATER than reality), it can only make an affected row look
 *      YOUNGER than it really is, which delays its deletion by at most a
 *      day; it can never make a row look OLDER than it really is, which
 *      would be the unsafe direction (deleting something too early).
 *   2. It is computed from `now`, not from `Date.now()` internally, so a
 *      caller can pass a fixed `now` for deterministic, reproducible
 *      boundary tests (see `retention.integration.spec.ts`).
 */
export function dayGranularityCutoff(now: Date, days: number): Date {
  const startOfUtcDay = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );

  return new Date(startOfUtcDay - days * MS_PER_DAY);
}
