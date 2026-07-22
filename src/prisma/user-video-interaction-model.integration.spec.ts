import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from './prisma.service';

/**
 * Integration-style spec confirming the `UserVideoInteraction` model (added
 * in Phase 9, work unit 9-B1) can be created and linked to a `User` via
 * `PrismaService`, that the unique `(userId, videoId)` constraint is
 * enforced (exactly one interaction row per user-per-video, matching
 * mobile's local `Record<videoId, VideoInteraction>` shape), and that
 * deleting a `User` cascades to delete their interaction rows. Uses the
 * project's dev SQLite database (same one `PrismaService` connects to
 * elsewhere in the test suite) but is fully self-cleaning: every row it
 * creates is deleted in `afterEach`.
 */
describe('UserVideoInteraction model (Prisma integration)', () => {
  let service: PrismaService;
  const testEmail = 'user-video-interaction-spec+9b1@example.test';
  const otherEmail = 'user-video-interaction-spec-other+9b1@example.test';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();

    service = module.get<PrismaService>(PrismaService);
    await service.onModuleInit();
  });

  afterEach(async () => {
    await service.userVideoInteraction.deleteMany({
      where: { user: { email: { in: [testEmail, otherEmail] } } },
    });
    await service.user.deleteMany({
      where: { email: { in: [testEmail, otherEmail] } },
    });
    await service.onModuleDestroy();
  });

  it('creates an interaction linked to a user', async () => {
    const user = await service.user.create({
      data: {
        email: testEmail,
        passwordHash: 'hashed-value-not-a-real-secret',
      },
    });

    const interaction = await service.userVideoInteraction.create({
      data: {
        userId: user.id,
        videoId: 'video-104-01',
        isLiked: true,
      },
    });

    expect(interaction.id).toEqual(expect.any(String));
    expect(interaction.userId).toBe(user.id);
    expect(interaction.videoId).toBe('video-104-01');
    expect(interaction.isLiked).toBe(true);
    expect(interaction.isSaved).toBe(false);
    expect(interaction.updatedAt).toBeInstanceOf(Date);

    const found = await service.userVideoInteraction.findUnique({
      where: { id: interaction.id },
    });

    expect(found).not.toBeNull();
    expect(found?.videoId).toBe('video-104-01');
  });

  it('enforces uniqueness on (userId, videoId)', async () => {
    const user = await service.user.create({
      data: {
        email: testEmail,
        passwordHash: 'hashed-value-not-a-real-secret',
      },
    });

    await service.userVideoInteraction.create({
      data: {
        userId: user.id,
        videoId: 'video-104-01',
      },
    });

    await expect(
      service.userVideoInteraction.create({
        data: {
          userId: user.id,
          videoId: 'video-104-01',
        },
      }),
    ).rejects.toThrow();

    // A different user liking/saving the same video is not blocked by the
    // constraint (it is scoped per-user, not global).
    const otherUser = await service.user.create({
      data: {
        email: otherEmail,
        passwordHash: 'hashed-value-not-a-real-secret',
      },
    });

    await expect(
      service.userVideoInteraction.create({
        data: {
          userId: otherUser.id,
          videoId: 'video-104-01',
        },
      }),
    ).resolves.toBeDefined();
  });

  it('cascade deletes interactions when their user is deleted', async () => {
    const user = await service.user.create({
      data: {
        email: testEmail,
        passwordHash: 'hashed-value-not-a-real-secret',
      },
    });

    const interaction = await service.userVideoInteraction.create({
      data: {
        userId: user.id,
        videoId: 'video-104-01',
        isSaved: true,
      },
    });

    await service.user.delete({ where: { id: user.id } });

    const found = await service.userVideoInteraction.findUnique({
      where: { id: interaction.id },
    });

    expect(found).toBeNull();
  });
});
