import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { EntitlementsService } from './entitlements.service';

/**
 * Integration-style spec (Phase 10, work unit 10-B6), following the
 * 9-B1/9-B2 `InteractionsService` precedent: real `PrismaService` against
 * the project's Postgres test database, self-cleaning via `afterEach`.
 */
describe('EntitlementsService', () => {
  let service: EntitlementsService;
  let prisma: PrismaService;

  const testIdPrefix = 'entitlements-service-spec';
  let userId: string;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [EntitlementsService, PrismaService],
    }).compile();

    service = module.get<EntitlementsService>(EntitlementsService);
    prisma = module.get<PrismaService>(PrismaService);
    await prisma.onModuleInit();

    const user = await prisma.user.create({
      data: {
        email: `${testIdPrefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
        passwordHash: 'irrelevant-for-this-spec',
      },
    });
    userId = user.id;
  });

  afterEach(async () => {
    await prisma.entitlement.deleteMany({
      where: { user: { email: { contains: testIdPrefix } } },
    });
    await prisma.user.deleteMany({
      where: { email: { contains: testIdPrefix } },
    });
    await prisma.onModuleDestroy();
  });

  describe('isEpisodePremium', () => {
    it('returns false for episodes at or below the free limit', () => {
      expect(service.isEpisodePremium(1, 5)).toBe(false);
      expect(service.isEpisodePremium(5, 5)).toBe(false);
    });

    it('returns true for episodes above the free limit', () => {
      expect(service.isEpisodePremium(6, 5)).toBe(true);
    });
  });

  describe('isEntitled / getStatus', () => {
    it('returns not-entitled for a user with no entitlement rows', async () => {
      expect(await service.isEntitled(userId)).toBe(false);
      expect(await service.getStatus(userId)).toEqual({
        isPremium: false,
        expiresAt: null,
      });
    });

    it('returns entitled for a user with a non-expiring active entitlement', async () => {
      await prisma.entitlement.create({
        data: { userId, tier: 'premium', source: 'dev-grant' },
      });

      expect(await service.isEntitled(userId)).toBe(true);
      expect(await service.getStatus(userId)).toEqual({
        isPremium: true,
        expiresAt: null,
      });
    });

    it('treats a revoked entitlement as not entitled', async () => {
      await prisma.entitlement.create({
        data: {
          userId,
          tier: 'premium',
          source: 'dev-grant',
          revokedAt: new Date(),
        },
      });

      expect(await service.isEntitled(userId)).toBe(false);
    });

    it('treats an expired entitlement as not entitled', async () => {
      await prisma.entitlement.create({
        data: {
          userId,
          tier: 'premium',
          source: 'dev-grant',
          expiresAt: new Date(Date.now() - 1000 * 60),
        },
      });

      expect(await service.isEntitled(userId)).toBe(false);
    });

    it('treats a not-yet-expired entitlement as entitled', async () => {
      const expiresAt = new Date(Date.now() + 1000 * 60 * 60);
      await prisma.entitlement.create({
        data: { userId, tier: 'premium', source: 'dev-grant', expiresAt },
      });

      const status = await service.getStatus(userId);
      expect(status.isPremium).toBe(true);
      expect(status.expiresAt).toBe(expiresAt.toISOString());
    });

    it("does not leak another user's entitlement", async () => {
      const otherUser = await prisma.user.create({
        data: {
          email: `${testIdPrefix}-other-${Date.now()}@example.test`,
          passwordHash: 'irrelevant-for-this-spec',
        },
      });
      await prisma.entitlement.create({
        data: { userId: otherUser.id, tier: 'premium', source: 'dev-grant' },
      });

      expect(await service.isEntitled(userId)).toBe(false);

      await prisma.entitlement.deleteMany({ where: { userId: otherUser.id } });
      await prisma.user.delete({ where: { id: otherUser.id } });
    });
  });

  describe('devGrant / devRevoke', () => {
    it('devGrant creates an active entitlement', async () => {
      const result = await service.devGrant(userId, undefined);
      expect(result).toEqual({ isPremium: true, expiresAt: null });
      expect(await service.isEntitled(userId)).toBe(true);
    });

    it('devGrant with expiresAt creates an entitlement that expires', async () => {
      const future = new Date(Date.now() + 1000 * 60 * 60).toISOString();
      const result = await service.devGrant(userId, future);
      expect(result.isPremium).toBe(true);
      expect(result.expiresAt).toBe(future);
    });

    it('devRevoke revokes an active entitlement', async () => {
      await service.devGrant(userId, undefined);
      expect(await service.isEntitled(userId)).toBe(true);

      const result = await service.devRevoke(userId);
      expect(result).toEqual({ isPremium: false, expiresAt: null });
      expect(await service.isEntitled(userId)).toBe(false);
    });

    it('devRevoke on a user with no entitlement is a harmless no-op', async () => {
      const result = await service.devRevoke(userId);
      expect(result).toEqual({ isPremium: false, expiresAt: null });
    });

    it('devGrant with a nonexistent targetUserId rejects with USER_NOT_FOUND instead of a raw DB error', async () => {
      await expect(
        service.devGrant('nonexistent-user-id', undefined),
      ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
    });

    it('devGrant after a prior revoke creates a fresh active entitlement without resurrecting the revoked row', async () => {
      await service.devGrant(userId, undefined);
      await service.devRevoke(userId);
      await service.devGrant(userId, undefined);

      expect(await service.isEntitled(userId)).toBe(true);
      const rows = await prisma.entitlement.findMany({ where: { userId } });
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.revokedAt === null)).toHaveLength(1);
    });
  });
});
