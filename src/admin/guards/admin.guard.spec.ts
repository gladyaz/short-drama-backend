import { ExecutionContext, HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminGuard } from './admin.guard';

type FindUniqueMock = jest.Mock<Promise<{ role: string } | null>, [unknown]>;

function buildContext(user?: { id: string }): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
}

/**
 * Phase 11, work unit 11B-2. `AdminGuard` is exercised here in isolation
 * (against a mocked `PrismaService.user.findUnique`), and again in
 * `test/admin.e2e-spec.ts` against the real HTTP layer + database.
 */
describe('AdminGuard', () => {
  let findUniqueMock: FindUniqueMock;
  let prisma: PrismaService;
  let guard: AdminGuard;

  beforeEach(() => {
    findUniqueMock = jest.fn<Promise<{ role: string } | null>, [unknown]>();
    prisma = {
      user: { findUnique: findUniqueMock },
    } as unknown as PrismaService;
    guard = new AdminGuard(prisma);
  });

  it('allows the request when the authenticated user has role "admin"', async () => {
    // Arrange
    findUniqueMock.mockResolvedValue({ role: 'admin' });
    const context = buildContext({ id: 'user-1' });

    // Act
    const result = await guard.canActivate(context);

    // Assert
    expect(result).toBe(true);
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { role: true },
    });
  });

  it('rejects with a 403 ADMIN_ROLE_REQUIRED when the user has role "user"', async () => {
    // Arrange
    findUniqueMock.mockResolvedValue({ role: 'user' });
    const context = buildContext({ id: 'user-2' });

    // Act & Assert
    let caught: unknown;
    try {
      await guard.canActivate(context);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppException);
    expect((caught as AppException).code).toBe('ADMIN_ROLE_REQUIRED');
    expect((caught as AppException).getStatus()).toBe(HttpStatus.FORBIDDEN);
  });

  it('rejects with 403 when the user record no longer exists', async () => {
    // Arrange
    findUniqueMock.mockResolvedValue(null);
    const context = buildContext({ id: 'deleted-user' });

    // Act & Assert
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: 'ADMIN_ROLE_REQUIRED',
    });
  });

  it('rejects with 403 when request.user is missing (guard misordering)', async () => {
    // Arrange
    const context = buildContext(undefined);

    // Act & Assert
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: 'ADMIN_ROLE_REQUIRED',
    });
    expect(findUniqueMock).not.toHaveBeenCalled();
  });
});
