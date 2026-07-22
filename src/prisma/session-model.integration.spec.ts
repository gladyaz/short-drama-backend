import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from './prisma.service';

/**
 * Integration-style spec confirming the `Session` model (added in Phase 8,
 * work unit 8-B3) can be created and linked to a `User` via `PrismaService`,
 * that the unique `refreshTokenHash` constraint is enforced, that deleting a
 * `User` cascades to delete their `Session` rows, and that the query shapes
 * needed later (8-B5/8-B6) to distinguish a valid session from a
 * revoked/expired one actually work against real SQLite.
 *
 * No revocation/refresh logic is implemented here — only the schema and the
 * query patterns are verified. Uses the project's dev SQLite database (same
 * one `PrismaService` connects to elsewhere in the test suite) but is fully
 * self-cleaning: every row it creates is deleted in `afterEach`.
 */
describe('Session model (Prisma integration)', () => {
  let service: PrismaService;
  const testEmail = 'session-model-spec+8b3@example.test';
  const otherEmail = 'session-model-spec-other+8b3@example.test';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();

    service = module.get<PrismaService>(PrismaService);
    await service.onModuleInit();
  });

  afterEach(async () => {
    await service.session.deleteMany({
      where: { user: { email: { in: [testEmail, otherEmail] } } },
    });
    await service.user.deleteMany({
      where: { email: { in: [testEmail, otherEmail] } },
    });
    await service.onModuleDestroy();
  });

  it('creates a session linked to a user', async () => {
    const user = await service.user.create({
      data: {
        email: testEmail,
        passwordHash: 'hashed-value-not-a-real-secret',
      },
    });

    const session = await service.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: 'hashed-refresh-token-1',
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      },
    });

    expect(session.id).toEqual(expect.any(String));
    expect(session.userId).toBe(user.id);
    expect(session.revokedAt).toBeNull();
    expect(session.createdAt).toBeInstanceOf(Date);

    const found = await service.session.findUnique({
      where: { id: session.id },
    });

    expect(found).not.toBeNull();
    expect(found?.refreshTokenHash).toBe('hashed-refresh-token-1');
  });

  it('enforces uniqueness on refreshTokenHash', async () => {
    const user = await service.user.create({
      data: {
        email: testEmail,
        passwordHash: 'hashed-value-not-a-real-secret',
      },
    });

    await service.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: 'hashed-refresh-token-shared',
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      },
    });

    const otherUser = await service.user.create({
      data: {
        email: otherEmail,
        passwordHash: 'hashed-value-not-a-real-secret',
      },
    });

    await expect(
      service.session.create({
        data: {
          userId: otherUser.id,
          refreshTokenHash: 'hashed-refresh-token-shared',
          expiresAt: new Date(Date.now() + 1000 * 60 * 60),
        },
      }),
    ).rejects.toThrow();
  });

  it('cascade deletes sessions when their user is deleted', async () => {
    const user = await service.user.create({
      data: {
        email: testEmail,
        passwordHash: 'hashed-value-not-a-real-secret',
      },
    });

    const session = await service.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: 'hashed-refresh-token-cascade',
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      },
    });

    await service.user.delete({ where: { id: user.id } });

    const found = await service.session.findUnique({
      where: { id: session.id },
    });

    expect(found).toBeNull();
  });

  it('distinguishes an active session from a revoked or expired one via query', async () => {
    const user = await service.user.create({
      data: {
        email: testEmail,
        passwordHash: 'hashed-value-not-a-real-secret',
      },
    });

    const now = new Date();
    const future = new Date(now.getTime() + 1000 * 60 * 60);
    const past = new Date(now.getTime() - 1000 * 60 * 60);

    const active = await service.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: 'hashed-refresh-token-active',
        expiresAt: future,
      },
    });

    const expired = await service.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: 'hashed-refresh-token-expired',
        expiresAt: past,
      },
    });

    const revoked = await service.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: 'hashed-refresh-token-revoked',
        expiresAt: future,
        revokedAt: now,
      },
    });

    const activeSessions = await service.session.findMany({
      where: {
        userId: user.id,
        revokedAt: null,
        expiresAt: { gt: now },
      },
    });

    expect(activeSessions.map((s) => s.id)).toEqual([active.id]);
    expect(activeSessions.map((s) => s.id)).not.toContain(expired.id);
    expect(activeSessions.map((s) => s.id)).not.toContain(revoked.id);
  });
});
