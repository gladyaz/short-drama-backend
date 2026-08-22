import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, RewardLedgerEntry, RewardWallet } from '@prisma/client';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { RewardReason, RewardSourceType } from './rewards.constants';

/**
 * Work unit "REWARDS BACKEND FOUNDATION": the ONLY writer of reward points in
 * this codebase. Every credit and every debit in the system goes through
 * `appendEntry`; no other service touches `RewardWallet.balancePoints`.
 *
 * That single-writer property is what makes the system's central invariant
 * checkable rather than merely stated:
 *
 *     the balance is a projection of the ledger — one immutable row per
 *     movement, and the projection is updated by the same transaction that
 *     appends the row, or not at all.
 *
 * WHY A SEPARATE SERVICE FROM `RewardsService`. `RewardsService` owns product
 * decisions ("is this user allowed to check in today?", "does this offer
 * exist?"). This class owns exactly one mechanical question: given a decided
 * movement, record it safely. Keeping them apart means a future earn path
 * cannot accidentally invent its own balance-mutation code — there is only
 * one, and it is 100 lines long and fully tested.
 */
@Injectable()
export class RewardsWalletService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reads the caller's wallet WITHOUT creating one.
   *
   * A fresh account has no `RewardWallet` row until its first movement, and
   * a plain `GET /rewards/snapshot` must not create one: a read endpoint that
   * writes turns every unauthenticated-feeling page view into a database
   * write, and would let an attacker with a stolen token spray rows into the
   * table by polling. Callers get a synthetic zero wallet instead, which is
   * numerically identical to the row that would have been created.
   */
  async readWallet(userId: string): Promise<WalletView> {
    const wallet = await this.prisma.rewardWallet.findUnique({
      where: { userId },
    });

    if (!wallet) {
      return {
        balancePoints: 0,
        lifetimeEarnedPoints: 0,
        version: 0,
        updatedAt: null,
      };
    }

    return {
      balancePoints: wallet.balancePoints,
      lifetimeEarnedPoints: wallet.lifetimeEarnedPoints,
      version: wallet.version,
      updatedAt: wallet.updatedAt,
    };
  }

  /**
   * Appends one immutable ledger entry and moves the balance projection by
   * the same delta, atomically.
   *
   * RUNS ON A CALLER-SUPPLIED `Prisma.TransactionClient`, deliberately. A
   * redemption must debit points and grant the entitlement in ONE database
   * transaction (mobile `docs/rewards-domain-contract.md` §5: "the point
   * debit and the entitlement grant are one atomic transaction: both succeed
   * or neither does"), which is only expressible if the caller owns the
   * transaction boundary. This mirrors `EntitlementsService.grantTimedPremium`,
   * which takes a `tx` for the same reason.
   *
   * ---------------------------------------------------------------------
   * HOW DOUBLE-PAYING IS PREVENTED — and why a `SELECT` then `INSERT` is
   * safe here even though the mobile contract warns that "check then insert
   * races under concurrency and will double-pay".
   *
   * That warning is correct about an UNSYNCHRONISED check-then-act. The race
   * is closed here by the FIRST statement of this method: a
   * `SELECT ... FOR UPDATE` row lock on the owning `User`. Postgres admits at
   * most one transaction past that statement per user, so the duplicate
   * lookup below and the insert that follows it are inside a per-user
   * critical section — a concurrent second claim BLOCKS on the lock, and by
   * the time it proceeds the first claim's row is committed and visible, so
   * it takes the replay branch instead of inserting.
   *
   * The `@@unique([userId, idempotencyKey])` constraint is retained as the
   * BACKSTOP, not as the mechanism: if a future writer ever reaches this
   * table without taking the lock, the database refuses the duplicate rather
   * than paying twice. Belt and braces, in that order.
   *
   * WHY NOT RELY ON THE CONSTRAINT ALONE (insert, catch `P2002`, replay)?
   * Because a failed statement inside a Postgres transaction ABORTS that
   * transaction — every subsequent statement fails with `25P02 current
   * transaction is aborted`. Catching `P2002` mid-transaction and then
   * reading the winner's row cannot work; the read would fail too. The
   * lock-first design keeps the whole operation on the success path.
   *
   * ---------------------------------------------------------------------
   * LOCK ORDER: `User` first, then `RewardWallet`. This is the CANONICAL AUTH
   * LOCK ORDER documented above `AuthService` extended to a new table, not a
   * new convention. It matters because a redemption calls
   * `EntitlementsService.grantTimedPremium` in the same transaction, and that
   * method also locks `User` first — taking the wallet lock first here would
   * create an inversion against `AuthService.deleteAccount`, which locks
   * `User` and then cascades into these very tables. Every rewards
   * transaction therefore holds the `User` lock before touching anything
   * else, which gives mutual exclusion per account and makes a cycle
   * impossible regardless of what runs afterwards.
   */
  async appendEntry(
    tx: Prisma.TransactionClient,
    input: AppendEntryInput,
  ): Promise<AppendEntryResult> {
    if (!Number.isInteger(input.deltaPoints) || input.deltaPoints === 0) {
      // A zero or fractional delta is a programming error, not a client
      // error: `deltaPoints` is always server-computed from config. Refusing
      // here keeps the `deltaPoints <> 0` CHECK constraint from being the
      // thing that surfaces the bug, as a 500 mid-transaction.
      throw new AppException(
        AppErrorCode.REWARD_LEDGER_INVALID_DELTA,
        'Reward ledger delta must be a non-zero integer',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    await this.lockAccount(tx, input.userId);

    const existing = await tx.rewardLedgerEntry.findUnique({
      where: {
        userId_idempotencyKey: {
          userId: input.userId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });

    if (existing) {
      // Idempotent replay: the caller is retrying an action that already
      // happened. Return the ORIGINAL entry and the CURRENT wallet — never a
      // second entry, and never a re-applied delta.
      const wallet = await this.requireWallet(tx, input.userId);
      return { entry: existing, wallet, replayed: true };
    }

    const wallet = await this.ensureWallet(tx, input.userId);
    const balanceAfter = wallet.balancePoints + input.deltaPoints;

    if (balanceAfter < 0) {
      throw new AppException(
        AppErrorCode.INSUFFICIENT_REWARD_POINTS,
        'Not enough reward points',
        HttpStatus.CONFLICT,
      );
    }

    const entry = await tx.rewardLedgerEntry.create({
      data: {
        userId: input.userId,
        walletId: wallet.id,
        deltaPoints: input.deltaPoints,
        reason: input.reason,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        idempotencyKey: input.idempotencyKey,
        balanceAfter,
        metadata: input.metadata ?? Prisma.JsonNull,
      },
    });

    const updated = await tx.rewardWallet.update({
      where: { id: wallet.id },
      data: {
        balancePoints: balanceAfter,
        // Lifetime earned counts CREDITS ONLY, so it never decreases — a
        // debit leaves it untouched. This is what makes "points you have
        // ever earned" a stable number a user can be shown, rather than a
        // figure that drops every time they spend.
        lifetimeEarnedPoints:
          input.deltaPoints > 0
            ? wallet.lifetimeEarnedPoints + input.deltaPoints
            : wallet.lifetimeEarnedPoints,
        version: { increment: 1 },
      },
    });

    return { entry, wallet: updated, replayed: false };
  }

  /**
   * Recomputes the balance from the ledger and reports whether the
   * projection agrees with it.
   *
   * The mobile contract's §1 rule — "reconcilable at any time by summing the
   * ledger. If the projection and the ledger sum ever disagree, the ledger
   * wins" — is only meaningful if something can actually perform the
   * comparison. This is that something. It is READ-ONLY on purpose: it
   * reports a divergence rather than repairing one, because a silent
   * self-heal would erase the evidence of whatever bug caused it. Repair is
   * a deliberate operator action (a `REVERSAL` or `ADJUSTMENT` entry).
   *
   * Used by the dev-tools reconcile route and asserted by the unit specs
   * after every mutation path, so a future change that updates the wallet
   * without appending an entry fails the suite.
   */
  async reconcile(userId: string): Promise<ReconciliationReport> {
    const [aggregate, credits, wallet] = await Promise.all([
      this.prisma.rewardLedgerEntry.aggregate({
        where: { userId },
        _sum: { deltaPoints: true },
      }),
      this.prisma.rewardLedgerEntry.aggregate({
        where: { userId, deltaPoints: { gt: 0 } },
        _sum: { deltaPoints: true },
      }),
      this.readWallet(userId),
    ]);

    const ledgerBalance = aggregate._sum.deltaPoints ?? 0;
    const ledgerLifetimeEarned = credits._sum.deltaPoints ?? 0;

    return {
      walletBalancePoints: wallet.balancePoints,
      ledgerBalancePoints: ledgerBalance,
      walletLifetimeEarnedPoints: wallet.lifetimeEarnedPoints,
      ledgerLifetimeEarnedPoints: ledgerLifetimeEarned,
      isConsistent:
        wallet.balancePoints === ledgerBalance &&
        wallet.lifetimeEarnedPoints === ledgerLifetimeEarned,
    };
  }

  /**
   * `SELECT ... FOR UPDATE` on the owning `User` row — the raw-SQL idiom
   * `AuthService` and `EntitlementsService.grantTimedPremium` already use, so
   * rewards participates in the existing lock order rather than inventing a
   * parallel one.
   *
   * An empty result means the account no longer exists (deleted mid-request;
   * every rewards table cascades with `User`). Surfacing that as a clean 404
   * beats letting it become a foreign-key violation two statements later.
   *
   * PUBLIC so a caller that must READ reward state before deciding what to
   * write (`RewardsService.checkIn` reads the streak row to compute the
   * award) can take the lock as ITS first statement too. Without that, the
   * read would happen outside the critical section and the decision could be
   * made from state a concurrent transaction is about to change.
   * Re-acquiring it inside `appendEntry` is a no-op — a row lock already
   * held by the same transaction is not re-taken.
   */
  async lockAccount(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;

    if (locked.length === 0) {
      throw new AppException(
        AppErrorCode.USER_NOT_FOUND,
        'User not found',
        HttpStatus.NOT_FOUND,
      );
    }
  }

  /**
   * Returns the user's wallet, creating it on first use.
   *
   * Safe against concurrent creation without an upsert race, because every
   * caller holds this user's `User` row lock by the time it gets here — at
   * most one transaction per account is ever in this method.
   */
  private async ensureWallet(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<RewardWallet> {
    const existing = await tx.rewardWallet.findUnique({ where: { userId } });
    if (existing) {
      return existing;
    }

    return tx.rewardWallet.create({ data: { userId } });
  }

  /**
   * The wallet that MUST exist because a ledger entry for it was just found.
   * A missing row here would mean the ledger and the projection have diverged
   * structurally, which is not something to paper over with a zero balance.
   */
  private async requireWallet(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<RewardWallet> {
    return tx.rewardWallet.findUniqueOrThrow({ where: { userId } });
  }
}

export interface AppendEntryInput {
  readonly userId: string;
  /** Signed, non-zero. Positive credits, negative debits. */
  readonly deltaPoints: number;
  readonly reason: RewardReason;
  readonly sourceType: RewardSourceType;
  readonly sourceId?: string | null;
  /**
   * Unique per user. SERVER-DERIVED for server-decided actions (a check-in is
   * keyed on its calendar date, so no client-supplied value can buy a second
   * payout for the same day); CLIENT-supplied only where repeating the action
   * is legitimate and only the client can distinguish a retry from a new
   * request (redemption).
   */
  readonly idempotencyKey: string;
  readonly metadata?: Prisma.InputJsonValue;
}

export interface AppendEntryResult {
  readonly entry: RewardLedgerEntry;
  readonly wallet: RewardWallet;
  /** True when the action had already been recorded and nothing was written. */
  readonly replayed: boolean;
}

export interface WalletView {
  readonly balancePoints: number;
  readonly lifetimeEarnedPoints: number;
  readonly version: number;
  readonly updatedAt: Date | null;
}

export interface ReconciliationReport {
  readonly walletBalancePoints: number;
  readonly ledgerBalancePoints: number;
  readonly walletLifetimeEarnedPoints: number;
  readonly ledgerLifetimeEarnedPoints: number;
  readonly isConsistent: boolean;
}
