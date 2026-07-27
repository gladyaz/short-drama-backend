import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  LOCKOUT_DURATION_MS,
  LOCKOUT_FAILURE_THRESHOLD,
  LOCKOUT_WINDOW_MS,
} from './auth.constants';

/**
 * Phase 12, work unit 12A-B1: persistent (PostgreSQL, survives restart)
 * failed-login lockout, keyed to an existing account — see DECISIONS.md
 * "Phase 12 ... approved..." entry, decision 4, and the `AccountLockout`
 * Prisma model's doc comment for the full design rationale.
 *
 * This is the ONLY code that reads or writes `AccountLockout`. It is called
 * exclusively from `AuthService.login`, and ONLY once an email has already
 * resolved to a real `User` row — never for a nonexistent email, so this
 * table can never be used to enumerate which emails are registered.
 *
 * Every method here is intentionally silent about *why* an account is
 * locked/unlocked: the caller (`AuthService.login`) collapses every outcome
 * (wrong password, nonexistent account, locked account) into the same
 * generic `INVALID_CREDENTIALS` error, per the anti-enumeration requirement.
 */
@Injectable()
export class AccountLockoutService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * True exactly when the account is currently within an active lock
   * window. Does not mutate any state (safe to call before deciding whether
   * to run `recordFailure`/`recordSuccess`).
   */
  async isLocked(userId: string): Promise<boolean> {
    const lockout = await this.prisma.accountLockout.findUnique({
      where: { userId },
      select: { lockedUntil: true },
    });
    return isWithinActiveLock(lockout?.lockedUntil ?? null);
  }

  /**
   * Records a failed login attempt for an account that was confirmed NOT
   * currently locked by the caller. Uses a rolling window: a failure either
   * starts a brand new window (no prior window, or the prior window is
   * older than `LOCKOUT_WINDOW_MS`) or increments the count within the
   * existing window. Once the count reaches `LOCKOUT_FAILURE_THRESHOLD`
   * within the window, `lockedUntil` is set `LOCKOUT_DURATION_MS` into the
   * future.
   *
   * Implemented as a single atomic `INSERT ... ON CONFLICT ("userId") DO
   * UPDATE` statement (Postgres's standard atomic-upsert idiom) rather than
   * a `find → compute → upsert` transaction. A read-then-write approach
   * (even inside a `$transaction`) is NOT safe under Postgres's default
   * READ COMMITTED isolation: concurrent failed-login calls for the same
   * account can all read the same pre-increment `failedCount` and each
   * write back `staleCount + 1`, silently losing updates — a genuine 20
   * concurrent failures could undercount to as few as 5-9, letting
   * concurrent/distributed brute-force attempts evade the lock threshold
   * entirely. `INSERT ... ON CONFLICT DO UPDATE` avoids this because
   * Postgres resolves the conflict by taking a row-level lock on the
   * existing row and serializing concurrent conflicting upserts against it,
   * so every concurrent call's `DO UPDATE` branch is evaluated against the
   * latest committed row, not a stale snapshot — no lost updates, and no
   * separate row needs to be pre-created. See the concurrency regression
   * test in `account-lockout.service.spec.ts` for a reproduction (fails
   * against the old `find → compute → upsert` implementation, passes here).
   *
   * `windowStartedAt`/`lockedUntil`/`updatedAt` are `timestamp without time
   * zone` columns (see `AccountLockout` in `schema.prisma`), and Prisma's
   * ORM consistently reads/writes them as naive UTC wall-clock digits (no
   * offset). A bound `Date` parameter sent to Postgres, however, always
   * carries an explicit `timestamptz` type; comparing/assigning it directly
   * against a naive column silently reinterprets those UTC digits in the
   * database session's OS-configured local time zone, shifting every value
   * by that offset. `(<param> AT TIME ZONE 'UTC')` converts the true-instant
   * `timestamptz` parameter into the same naive-UTC-digits representation
   * Prisma's ORM already uses, so every value stored/compared here lines up
   * exactly with `isLocked`/`recordSuccess`'s reads and normal Prisma writes
   * regardless of the database server's local time zone setting.
   */
  async recordFailure(userId: string): Promise<void> {
    const now = new Date();
    const newRowId = randomUUID();

    await this.prisma.$executeRaw`
      INSERT INTO "AccountLockout" AS al
        ("id", "userId", "failedCount", "windowStartedAt", "lockedUntil", "updatedAt")
      VALUES
        (${newRowId}, ${userId}, 1, (${now} AT TIME ZONE 'UTC'), NULL, (${now} AT TIME ZONE 'UTC'))
      ON CONFLICT ("userId") DO UPDATE SET
        "failedCount" = CASE
          WHEN al."windowStartedAt" IS NULL
            OR al."windowStartedAt" < (${now} AT TIME ZONE 'UTC') - (${LOCKOUT_WINDOW_MS}::double precision * interval '1 millisecond')
            THEN 1
          ELSE al."failedCount" + 1
        END,
        "windowStartedAt" = CASE
          WHEN al."windowStartedAt" IS NULL
            OR al."windowStartedAt" < (${now} AT TIME ZONE 'UTC') - (${LOCKOUT_WINDOW_MS}::double precision * interval '1 millisecond')
            THEN (${now} AT TIME ZONE 'UTC')
          ELSE al."windowStartedAt"
        END,
        "lockedUntil" = CASE
          WHEN (
            CASE
              WHEN al."windowStartedAt" IS NULL
                OR al."windowStartedAt" < (${now} AT TIME ZONE 'UTC') - (${LOCKOUT_WINDOW_MS}::double precision * interval '1 millisecond')
                THEN 1
              ELSE al."failedCount" + 1
            END
          ) >= ${LOCKOUT_FAILURE_THRESHOLD}
            THEN (${now} AT TIME ZONE 'UTC') + (${LOCKOUT_DURATION_MS}::double precision * interval '1 millisecond')
          ELSE NULL
        END,
        "updatedAt" = (${now} AT TIME ZONE 'UTC')
      WHERE al."userId" = ${userId};
    `;
  }

  /**
   * Resets any failed-login state for the account after a successful login.
   * Deliberately a no-op (via `updateMany`, not `upsert`) when no
   * `AccountLockout` row exists yet — a user who has never failed a login
   * has nothing to reset, so no row is created on the common case (every
   * ordinary successful login).
   */
  async recordSuccess(userId: string): Promise<void> {
    await this.prisma.accountLockout.updateMany({
      where: { userId },
      data: { failedCount: 0, windowStartedAt: null, lockedUntil: null },
    });
  }
}

function isWithinActiveLock(lockedUntil: Date | null): boolean {
  return lockedUntil !== null && lockedUntil.getTime() > Date.now();
}
