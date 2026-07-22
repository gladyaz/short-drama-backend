import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from './prisma.service';

/**
 * Integration-style spec confirming the `User` model (added in Phase 8,
 * work unit 8-B2) can be created and read via `PrismaService`, and that the
 * unique `email` constraint is enforced by the database. Uses the project's
 * dev SQLite database (same one `PrismaService` connects to elsewhere in the
 * test suite) but is fully self-cleaning: every row it creates is deleted in
 * `afterEach`, so it leaves no residue behind.
 */
describe('User model (Prisma integration)', () => {
  let service: PrismaService;
  const testEmail = 'user-model-spec+8b2@example.test';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();

    service = module.get<PrismaService>(PrismaService);
    await service.onModuleInit();
  });

  afterEach(async () => {
    await service.user.deleteMany({ where: { email: testEmail } });
    await service.onModuleDestroy();
  });

  it('creates and reads back a user', async () => {
    const created = await service.user.create({
      data: {
        email: testEmail,
        passwordHash: 'hashed-value-not-a-real-secret',
        displayName: 'Test User',
      },
    });

    expect(created.id).toEqual(expect.any(String));
    expect(created.email).toBe(testEmail);
    expect(created.displayName).toBe('Test User');
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);

    const found = await service.user.findUnique({
      where: { id: created.id },
    });

    expect(found).not.toBeNull();
    expect(found?.email).toBe(testEmail);
  });

  it('enforces uniqueness on email', async () => {
    await service.user.create({
      data: {
        email: testEmail,
        passwordHash: 'hashed-value-not-a-real-secret',
      },
    });

    await expect(
      service.user.create({
        data: {
          email: testEmail,
          passwordHash: 'another-hashed-value',
        },
      }),
    ).rejects.toThrow();
  });

  it('allows displayName to be omitted', async () => {
    const created = await service.user.create({
      data: {
        email: testEmail,
        passwordHash: 'hashed-value-not-a-real-secret',
      },
    });

    expect(created.displayName).toBeNull();
  });
});
