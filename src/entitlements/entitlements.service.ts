import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
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
