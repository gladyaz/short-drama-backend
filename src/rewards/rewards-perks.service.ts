import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, RewardPerk } from '@prisma/client';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import {
  REWARD_PERK_STATUSES,
  REWARD_PERK_TYPES,
  RewardPerkGrantSpec,
} from './rewards.constants';
import {
  ActivePerksDto,
  RewardPerkDto,
  RewardPerkTypeDto,
} from './rewards.types';

/**
 * Work unit "REWARDS V1 EARN AND SPEND": the ONLY writer of `RewardPerk`, and
 * the one place that decides whether a perk is currently live.
 *
 * WHY A SEPARATE SERVICE. It mirrors `RewardsWalletService`'s split exactly:
 * `RewardsService` owns the product decision ("this offer costs 150 points
 * and buys an ad skip"), this class owns the mechanical one ("given a decided
 * grant, record it; given a perk id, spend it exactly once"). Keeping them
 * apart is what stops a future caller from inventing a second way to issue or
 * consume a perk.
 *
 * NO AD SDK LIVES HERE, and none ever should. This module has no idea which
 * ad would have been shown, which network would have served it, or what it
 * would have paid. It answers exactly one question — does this account hold a
 * perk that says an interstitial should be skipped — and the mobile ad layer
 * decides what to do about it.
 *
 * ---------------------------------------------------------------------------
 * LIVENESS IS DERIVED FROM THE CLOCK, NEVER READ FROM `status`
 *
 * `isActive(perk, now)` below is the single definition of "live", and it
 * checks `expiresAt` against the passed instant on every read. The stored
 * `status` column is an audit record of what has been OBSERVED, not the
 * authority — because a status column can only ever be as fresh as the last
 * job that touched it, and there is no such job here.
 *
 * The failure mode this avoids is the one that matters commercially: a
 * two-hour ad pass that keeps suppressing ads for a week because nothing ran
 * to mark it `EXPIRED`. Deriving liveness means the perk stops working at
 * exactly `expiresAt`, with no moving parts.
 *
 * ---------------------------------------------------------------------------
 * CONSUMPTION IS A CONDITIONAL UPDATE, NOT READ-THEN-WRITE
 *
 * `consume` spends a perk with a single `updateMany` whose WHERE clause
 * carries every precondition (right owner, still `ACTIVE`, uses remaining,
 * not expired). Postgres evaluates that atomically, so two concurrent
 * consume calls cannot both match: one reports `count: 1` and spent it, the
 * other reports `count: 0` and reports `alreadyConsumed`. No row lock, no
 * transaction, and no `SELECT` that a competitor can invalidate before the
 * `UPDATE` lands.
 *
 * This deliberately does NOT take the `User` lock the wallet path takes.
 * Consuming a perk moves no points and touches no balance, so it does not
 * belong in the wallet's critical section — and holding the account lock for
 * an operation that happens on every ad break would put ad presentation in
 * contention with check-ins and redemptions for no benefit.
 */
@Injectable()
export class RewardsPerksService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Issues the perk an `AD_PERK` redemption bought.
   *
   * RUNS ON THE CALLER'S TRANSACTION, for the same reason
   * `EntitlementsService.grantTimedPremium` does: the debit and the thing the
   * debit bought must commit together or not at all. A user must never be
   * charged 150 points for an ad skip that was not issued, and must never
   * hold an ad skip nobody paid for.
   */
  async issuePerk(
    tx: Prisma.TransactionClient,
    userId: string,
    spec: RewardPerkGrantSpec,
    now: Date,
  ): Promise<RewardPerk> {
    const expiresAt = new Date(now.getTime() + spec.durationMinutes * 60_000);

    return tx.rewardPerk.create({
      data: {
        userId,
        perkType: spec.type,
        status: REWARD_PERK_STATUSES.ACTIVE,
        remainingUses: spec.uses,
        grantedAt: now,
        expiresAt,
      },
    });
  }

  /**
   * Everything the mobile ad-presentation layer needs to decide whether to
   * show an interstitial, in one read.
   *
   * READ-ONLY. It does not mark expired perks `EXPIRED` — a GET that writes
   * turns every ad break into a database write, and the derived liveness
   * check above means nothing depends on that column being fresh.
   */
  async getActivePerks(
    userId: string,
    now = new Date(),
  ): Promise<ActivePerksDto> {
    const rows = await this.prisma.rewardPerk.findMany({
      where: {
        userId,
        status: REWARD_PERK_STATUSES.ACTIVE,
        expiresAt: { gt: now },
      },
      orderBy: [{ expiresAt: 'asc' }],
    });

    // The query already excludes the expired and the non-ACTIVE; re-filtering
    // through `isActive` is what makes the `remainingUses > 0` half of the
    // rule live in ONE place rather than being half in a WHERE clause and
    // half in a helper that could drift from it.
    const active = rows.filter((perk) => isActive(perk, now));

    return {
      perks: active.map(toPerkDto),
      skipNextInterstitial: active.some(
        (perk) => perk.perkType === REWARD_PERK_TYPES.SKIP_NEXT_INTERSTITIAL,
      ),
      adFreeUntil: furthestExpiry(
        active.filter(
          (perk) => perk.perkType === REWARD_PERK_TYPES.TEMPORARY_AD_PASS,
        ),
      ),
    };
  }

  /**
   * Spends a single-use perk. Idempotent: a second call for the same perk
   * changes nothing and says so.
   *
   * A `TEMPORARY_AD_PASS` is REFUSED here rather than quietly accepted. It is
   * spent by the clock, so "consuming" one could only mean destroying time
   * the user paid for — a client that calls this against a pass has a bug,
   * and answering 200 would hide it until someone noticed their two hours
   * ending early.
   */
  async consume(
    userId: string,
    perkId: string,
    now = new Date(),
  ): Promise<{ consumed: boolean; alreadyConsumed: boolean }> {
    // Scoped to the caller's own id, so a perk id belonging to another
    // account is indistinguishable from one that does not exist — the same
    // ownership-scoped 404 shape every other per-user resource in this API
    // uses.
    const perk = await this.prisma.rewardPerk.findFirst({
      where: { id: perkId, userId },
    });

    if (!perk) {
      throw new AppException(
        AppErrorCode.REWARD_PERK_NOT_FOUND,
        'Perk not found',
        HttpStatus.NOT_FOUND,
      );
    }

    if (perk.perkType !== REWARD_PERK_TYPES.SKIP_NEXT_INTERSTITIAL) {
      throw new AppException(
        AppErrorCode.REWARD_PERK_NOT_CONSUMABLE,
        'This perk is time-based and is not consumed by the client',
        HttpStatus.CONFLICT,
      );
    }

    if (perk.expiresAt <= now) {
      throw new AppException(
        AppErrorCode.REWARD_PERK_EXPIRED,
        'This perk has expired',
        HttpStatus.CONFLICT,
      );
    }

    // THE ATOMIC STEP. Every precondition is in the WHERE clause, so the
    // check and the write are one statement and a concurrent caller cannot
    // slip between them. `count` is the answer to "did I spend it?".
    const spent = await this.prisma.rewardPerk.updateMany({
      where: {
        id: perkId,
        userId,
        status: REWARD_PERK_STATUSES.ACTIVE,
        remainingUses: { gt: 0 },
        expiresAt: { gt: now },
      },
      data: {
        remainingUses: 0,
        status: REWARD_PERK_STATUSES.CONSUMED,
        consumedAt: now,
      },
    });

    if (spent.count === 1) {
      return { consumed: true, alreadyConsumed: false };
    }

    // Lost the race, or it was already spent before this call. Both are the
    // same fact from the caller's point of view: the perk is gone.
    return { consumed: false, alreadyConsumed: true };
  }

  /**
   * Marks observably-expired perks `EXPIRED`.
   *
   * Purely cosmetic for the data — nothing reads `status` to decide liveness
   * (see the class doc) — so it is safe never to run it. It exists so an
   * operator browsing the table is not misled by a row that says `ACTIVE`
   * beside an expiry from last month.
   */
  async markExpired(userId: string, now = new Date()): Promise<number> {
    const result = await this.prisma.rewardPerk.updateMany({
      where: {
        userId,
        status: REWARD_PERK_STATUSES.ACTIVE,
        expiresAt: { lte: now },
      },
      data: { status: REWARD_PERK_STATUSES.EXPIRED },
    });

    return result.count;
  }
}

/**
 * The single definition of "this perk is live right now".
 *
 * A single-use perk is live while it is unexpired AND has a use left; a
 * duration perk is live while it is unexpired. `remainingUses === null` is
 * the duration case and must not be read as "zero uses", which is why the
 * null check is explicit rather than a truthiness test.
 */
export function isActive(perk: RewardPerk, now: Date): boolean {
  if (perk.status !== REWARD_PERK_STATUSES.ACTIVE) {
    return false;
  }

  if (perk.expiresAt <= now) {
    return false;
  }

  return perk.remainingUses === null || perk.remainingUses > 0;
}

export function toPerkDto(perk: RewardPerk): RewardPerkDto {
  return {
    id: perk.id,
    perkType: perk.perkType as RewardPerkTypeDto,
    expiresAt: perk.expiresAt.toISOString(),
    remainingUses: perk.remainingUses,
    grantedAt: perk.grantedAt.toISOString(),
  };
}

function furthestExpiry(perks: RewardPerk[]): string | null {
  if (perks.length === 0) {
    return null;
  }

  // Two overlapping passes are additive from the user's point of view: they
  // bought ad-free time twice and should get the later of the two ends, not
  // whichever the query happened to sort first.
  const furthest = perks.reduce((latest, perk) =>
    perk.expiresAt > latest.expiresAt ? perk : latest,
  );

  return furthest.expiresAt.toISOString();
}
