import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { AdminService } from './admin.service';

/**
 * Integration-style spec (Phase 11, work unit 11B-2), following the
 * `EntitlementsService` precedent: real `PrismaService` against the
 * project's Postgres test database, self-cleaning via `afterEach`.
 */
describe('AdminService', () => {
  let service: AdminService;
  let prisma: PrismaService;

  const testIdPrefix = 'admin-service-spec-11b2';
  let userId: string;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AdminService, PrismaService],
    }).compile();

    service = module.get<AdminService>(AdminService);
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
    await prisma.user.deleteMany({
      where: { email: { contains: testIdPrefix } },
    });
    await prisma.onModuleDestroy();
  });

  describe('getRoleStatus', () => {
    it('returns role "user" for a freshly created account', async () => {
      const status = await service.getRoleStatus(userId);
      expect(status).toEqual({ userId, role: 'user' });
    });

    it('rejects with USER_NOT_FOUND for a nonexistent id', async () => {
      await expect(
        service.getRoleStatus('nonexistent-user-id'),
      ).rejects.toMatchObject({ code: AppErrorCode.USER_NOT_FOUND });
    });
  });

  describe('devGrantAdminRole / devRevokeAdminRole', () => {
    it('grants the admin role', async () => {
      const result = await service.devGrantAdminRole(userId);
      expect(result).toEqual({ userId, role: 'admin' });

      const status = await service.getRoleStatus(userId);
      expect(status.role).toBe('admin');
    });

    it('revokes back to the default "user" role', async () => {
      await service.devGrantAdminRole(userId);
      const result = await service.devRevokeAdminRole(userId);

      expect(result).toEqual({ userId, role: 'user' });
    });

    it('granting one user does not affect another user', async () => {
      const otherUser = await prisma.user.create({
        data: {
          email: `${testIdPrefix}-other-${Date.now()}@example.test`,
          passwordHash: 'irrelevant-for-this-spec',
        },
      });

      await service.devGrantAdminRole(userId);

      const otherStatus = await service.getRoleStatus(otherUser.id);
      expect(otherStatus.role).toBe('user');
    });

    it('devGrantAdminRole rejects with USER_NOT_FOUND for a nonexistent targetUserId', async () => {
      let caught: unknown;
      try {
        await service.devGrantAdminRole('nonexistent-user-id');
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AppException);
      expect((caught as AppException).code).toBe(AppErrorCode.USER_NOT_FOUND);
    });

    it('devRevokeAdminRole rejects with USER_NOT_FOUND for a nonexistent targetUserId', async () => {
      await expect(
        service.devRevokeAdminRole('nonexistent-user-id'),
      ).rejects.toMatchObject({ code: AppErrorCode.USER_NOT_FOUND });
    });
  });
});
