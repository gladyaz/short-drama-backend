import { HttpStatus, Injectable } from '@nestjs/common';
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
