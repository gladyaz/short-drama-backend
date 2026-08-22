import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { resolveAccessTier } from './entitlement.constants';
import { EntitlementStatusDto } from './entitlement.types';

const PREMIUM_TIER = 'premium';
const DEV_GRANT_SOURCE = 'dev-grant';

/**
 * Phase 10, work unit 10-B2: account-wide entitlement decisions. A row in
 * `Entitlement` counts as currently active only when both `revokedAt IS NULL`
 * and (`expiresAt IS NULL` or `expiresAt` is in the future) — see the schema
 * comment on the `Entitlement` model and DECISIONS.md "Phase 10 approved..."
 * entry, default decisions 3/4/5, for why expired/revoked collapse to the
 * same "not entitled" outcome and why this is account-wide, not per-series.
 */
@Injectable()
export class EntitlementsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * True if `episodeNumber` requires an active entitlement to stream at all.
   * A pure function of the episode number, mirroring mobile's
   * `series-service.ts::FREE_EPISODE_LIMIT` exactly so the two never drift —
   * see DECISIONS.md default decision 5 (account-wide, no per-series gate).
   */
  isEpisodePremium(episodeNumber: number, freeEpisodeLimit: number): boolean {
    return episodeNumber > freeEpisodeLimit;
  }

  /**
   * Work unit 11E-3: per-episode admin access-tier override resolution,
   * used by `VideosController#streamVideo` in place of a direct
   * `isEpisodePremium` call. `accessTierOverride` is the raw nullable
   * `Video.accessTierOverride` column value (set/cleared via the guarded
   * `PATCH /admin/media/:id/access-tier` endpoint): `"premium"` and
   * `"free"` unconditionally decide the outcome regardless of
   * `episodeNumber`.
   *
   * Work unit 11F-4: this DB column is now the enforcement source of truth
   * for every real row, not just an opt-in override. A one-time additive
   * backfill migration filled `accessTierOverride` for all 40 pre-existing
   * rows with their previously-derived value (see
   * `prisma/migrations/*_backfill_video_access_tier_override/migration.sql`),
   * `prisma/seed.ts` now sets it explicitly on every freshly seeded row, and
   * `AdminMediaService.createUpload` sets it explicitly on every newly
   * created row — so in normal operation this method's two `if` branches
   * above are the ONLY code path that matters; `episodeNumber` is no longer
   * consulted for gating an override-bearing row. The `isEpisodePremium`
   * fallback below is retained solely as a **null-safety fallback** for a
   * row that is somehow still `null` (there should be none after the
   * backfill, but the column has no NOT NULL constraint, so this keeps the
   * gate fail-safe rather than throwing). This is purely additive:
   * `isEpisodePremium` itself is untouched, so this method's null-override
   * branch always returns exactly what the old default rule already
   * returned for any row that predates this work unit and was somehow left
   * `null`.
   *
   * Work unit "Episode Access-Tier + Category Contract Hardening": the
   * override-vs-default decision itself now lives in ONE place,
   * `resolveAccessTier` (`entitlement.constants.ts`) — this method delegates
   * to it rather than re-implementing the same two-branch check inline, so
   * this boolean gate and the new `VideoResponseDto.accessTier` field (built
   * from the same `resolveAccessTier` call) can never disagree. Behavior is
   * byte-identical to before this refactor (see
   * `entitlements.service.spec.ts`, unchanged and still passing).
   */
  resolveEpisodePremium(
    input: {
      accessTierOverride: string | null | undefined;
      episodeNumber: number;
    },
    freeEpisodeLimit: number,
  ): boolean {
    return resolveAccessTier(input, freeEpisodeLimit) === 'premium';
  }

  /**
   * Whether `userId` currently holds an active premium entitlement. Used
   * both by the stream guard (10-B3) and the status endpoint (10-B4).
   */
  async isEntitled(userId: string): Promise<boolean> {
    const active = await this.findActiveEntitlement(userId);
    return active !== null;
  }

  async getStatus(userId: string): Promise<EntitlementStatusDto> {
    const active = await this.findActiveEntitlement(userId);

    return {
      isPremium: active !== null,
      expiresAt: active?.expiresAt?.toISOString() ?? null,
    };
  }

  /**
   * Dev-only (work unit 10-B5): grants a fresh premium entitlement to
   * `userId`. Does not attempt to merge with or extend an existing active
   * entitlement — each grant is its own row, matching `Session`'s existing
   * "new row per issuance" convention rather than mutating history in place.
   */
  async devGrant(
    userId: string,
    expiresAt: string | undefined,
  ): Promise<EntitlementStatusDto> {
    await this.assertUserExists(userId);

    const created = await this.prisma.entitlement.create({
      data: {
        userId,
        tier: PREMIUM_TIER,
        source: DEV_GRANT_SOURCE,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      },
    });

    return {
      isPremium: true,
      expiresAt: created.expiresAt?.toISOString() ?? null,
    };
  }

  /**
   * Dev-only (work unit 10-B5): revokes every currently-active entitlement
   * for `userId` by setting `revokedAt`, matching `Session`'s existing
   * soft-revoke pattern (never a hard delete, so history stays auditable).
   */
  async devRevoke(userId: string): Promise<EntitlementStatusDto> {
    await this.prisma.entitlement.updateMany({
      where: {
        userId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    return { isPremium: false, expiresAt: null };
  }

  /**
   * Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION": grants (or extends)
   * time-bound premium as the result of an authoritatively-successful
   * payment. This is the ONLY payment-facing entitlement writer — the
   * payments module never touches the `Entitlement` table directly, so
   * premium semantics stay owned by this module (the "no parallel Premium
   * system" requirement).
   *
   * Runs on a CALLER-SUPPLIED `Prisma.TransactionClient` — the caller
   * (`PaymentNotificationService.applyPaidTransition`) commits this grant in
   * the SAME transaction as the order's `PAID` CAS, so "order says PAID"
   * and "premium was granted" can never disagree, and the caller's CAS win
   * is what guarantees at-most-one grant per order even under concurrent
   * duplicate webhook delivery.
   *
   * First statement is a `SELECT ... FOR UPDATE` on the `User` row — the
   * same raw-SQL row-lock idiom `AuthService` already uses (and the same
   * lock-ORDER: User first, dependent rows after, so this cannot form a
   * lock cycle with the auth flows). It serializes concurrent grants for
   * the SAME user across DIFFERENT orders: without it, two simultaneously
   * settling orders could both read the same current expiry and both write
   * `expiry + 30d`, silently losing one purchased month. With it, the
   * second transaction waits and extends the first one's result.
   * An empty lock result means the user row no longer exists (account
   * deleted mid-payment; `PaymentOrder.userId` is `SetNull`) — returns
   * `null` so the caller can record the payment without a grant instead of
   * crashing on an FK violation.
   *
   * EXTEND semantics: the new row's `expiresAt` counts `durationDays` from
   * `max(now, latest active dated expiry)` — buying a second month while
   * one is still running stacks, buying after a lapse starts from now. An
   * active UNLIMITED entitlement (`expiresAt: null`, dev-grant only) is not
   * "extended" (there is nothing beyond forever); the purchase still
   * creates its own dated row, preserving the one-row-per-grant audit
   * convention `devGrant` established.
   */
  async grantPaidPremium(
    tx: Prisma.TransactionClient,
    userId: string,
    durationDays: number,
    source: string,
  ): Promise<{ id: string; expiresAt: Date } | null> {
    return this.grantTimedPremium(tx, userId, durationDays, source);
  }

  /**
   * Work unit "REWARDS BACKEND FOUNDATION": the general, funding-agnostic
   * time-bound premium grant. This is the body `grantPaidPremium` has always
   * had, lifted verbatim behind a name that does not claim to know WHY the
   * premium was granted — `grantPaidPremium` now delegates to it unchanged,
   * so payment behavior is byte-identical to before this extraction.
   *
   * WHY EXTRACT INSTEAD OF ADDING A SECOND GRANT METHOD. Reward redemption
   * needs exactly these semantics — lock the user, stack onto any active
   * dated expiry, create one audit row — and the one thing this domain must
   * never grow is a SECOND way to become premium. The mobile domain contract
   * is explicit that redeeming "grants an entitlement through the same
   * system everything else uses", and this module's own doc comment already
   * committed to being the single owner of premium semantics. Two nearly
   * identical grant paths is how that ownership rots: they drift, and then
   * "am I premium?" depends on how you got there.
   *
   * The caller supplies `source` (`"reward-redemption"`, a payment plan id,
   * `"dev-grant"`), which is what keeps the funding story auditable from the
   * `Entitlement` row alone without encoding it in the method name.
   */
  async grantTimedPremium(
    tx: Prisma.TransactionClient,
    userId: string,
    durationDays: number,
    source: string,
  ): Promise<{ id: string; expiresAt: Date } | null> {
    const lockedUser = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;

    if (lockedUser.length === 0) {
      return null;
    }

    const now = new Date();
    const activeRows = await tx.entitlement.findMany({
      where: {
        userId,
        tier: PREMIUM_TIER,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { expiresAt: true },
    });

    let base = now;
    for (const row of activeRows) {
      if (row.expiresAt !== null && row.expiresAt.getTime() > base.getTime()) {
        base = row.expiresAt;
      }
    }

    const expiresAt = new Date(
      base.getTime() + durationDays * 24 * 60 * 60 * 1000,
    );

    const created = await tx.entitlement.create({
      data: {
        userId,
        tier: PREMIUM_TIER,
        source,
        expiresAt,
      },
      select: { id: true, expiresAt: true },
    });

    return { id: created.id, expiresAt: created.expiresAt ?? expiresAt };
  }

  /**
   * Dev-only routes accept an arbitrary `targetUserId` string from the
   * request body (see `dto/dev-grant-entitlement.dto.ts`) — without this
   * check, a nonexistent id would surface as an unstructured 500 from a
   * Prisma foreign-key violation on `entitlement.create` instead of a clean
   * 4xx.
   */
  private async assertUserExists(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      throw new AppException(
        AppErrorCode.USER_NOT_FOUND,
        'User not found',
        HttpStatus.NOT_FOUND,
      );
    }
  }

  private async findActiveEntitlement(userId: string) {
    const now = new Date();

    return this.prisma.entitlement.findFirst({
      where: {
        userId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: { grantedAt: 'desc' },
    });
  }
}
