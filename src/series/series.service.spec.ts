import { Test, TestingModule } from '@nestjs/testing';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { SeriesService } from './series.service';

/**
 * Phase 11, work unit 11E-4: `PrismaService` is the real client against the
 * project's Postgres test database (following the existing
 * `AdminMediaService`/`EntitlementsService` integration-style precedent),
 * self-cleaning via `afterEach`. No `StorageService`/filesystem/network
 * dependency exists for this service — a `Series` row is pure metadata.
 */
describe('SeriesService', () => {
  let service: SeriesService;
  let prisma: PrismaService;

  const testIdPrefix = 'series-spec-11e4';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SeriesService, PrismaService],
    }).compile();

    service = module.get<SeriesService>(SeriesService);
    prisma = module.get<PrismaService>(PrismaService);
    await prisma.onModuleInit();
  });

  afterEach(async () => {
    await prisma.series.deleteMany({
      where: { id: { startsWith: testIdPrefix } },
    });
    await prisma.onModuleDestroy();
  });

  describe('create', () => {
    it('creates a series and returns a SeriesDto', async () => {
      const id = `${testIdPrefix}-create-basic`;

      const result = await service.create({ id, title: 'My Series' });

      expect(result).toMatchObject({
        id,
        title: 'My Series',
        coverImageKey: null,
        sortOrder: 0,
      });
      expect(typeof result.createdAt).toBe('string');
      expect(typeof result.updatedAt).toBe('string');

      const persisted = await prisma.series.findUnique({ where: { id } });
      expect(persisted).not.toBeNull();
    });

    it('persists optional coverImageKey and sortOrder when provided', async () => {
      const id = `${testIdPrefix}-create-optional`;

      const result = await service.create({
        id,
        title: 'My Series',
        coverImageKey: 'series/cover.jpg',
        sortOrder: 5,
      });

      expect(result.coverImageKey).toBe('series/cover.jpg');
      expect(result.sortOrder).toBe(5);
    });

    it('rejects a duplicate id with a clean 409 AppException, not a raw DB error', async () => {
      const id = `${testIdPrefix}-create-dup`;
      await service.create({ id, title: 'First' });

      let caught: unknown;
      try {
        await service.create({ id, title: 'Second' });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AppException);
      expect((caught as AppException).code).toBe(
        AppErrorCode.SERIES_ALREADY_EXISTS,
      );
      expect((caught as AppException).getStatus()).toBe(409);

      // The original row is untouched.
      const persisted = await prisma.series.findUnique({ where: { id } });
      expect(persisted?.title).toBe('First');
    });
  });

  describe('list', () => {
    it('returns created rows ordered by sortOrder then id', async () => {
      const seriesA = `${testIdPrefix}-list-b-tiebreak`;
      const seriesB = `${testIdPrefix}-list-a-tiebreak`;
      const seriesC = `${testIdPrefix}-list-first`;

      // Same sortOrder (0) for A and B — tie-break falls back to id asc.
      await service.create({ id: seriesA, title: 'A' });
      await service.create({ id: seriesB, title: 'B' });
      // Lower sortOrder, sorts first regardless of id.
      await service.create({ id: seriesC, title: 'C', sortOrder: -5 });

      const result = await service.list();
      const ids = result
        .filter((s) => s.id.startsWith(testIdPrefix))
        .map((s) => s.id);

      expect(ids).toEqual([seriesC, seriesB, seriesA]);
    });

    it('returns an empty array when no series exist', async () => {
      const result = await service.list();
      const matching = result.filter((s) => s.id.startsWith(testIdPrefix));
      expect(matching).toEqual([]);
    });
  });

  describe('update', () => {
    it('updates provided fields and preserves the others', async () => {
      const id = `${testIdPrefix}-update-partial`;
      await service.create({
        id,
        title: 'Original Title',
        coverImageKey: 'series/original.jpg',
        sortOrder: 2,
      });

      const updated = await service.update(id, { title: 'New Title' });

      expect(updated.title).toBe('New Title');
      expect(updated.coverImageKey).toBe('series/original.jpg');
      expect(updated.sortOrder).toBe(2);
    });

    it('bumps updatedAt on a successful update', async () => {
      const id = `${testIdPrefix}-update-bump`;
      const created = await service.create({ id, title: 'Original' });

      await new Promise((resolve) => setTimeout(resolve, 10));
      const updated = await service.update(id, { title: 'Bumped' });

      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(
        new Date(created.updatedAt).getTime(),
      );
      expect(updated.createdAt).toBe(created.createdAt);
    });

    it('updates multiple fields at once', async () => {
      const id = `${testIdPrefix}-update-multi`;
      await service.create({ id, title: 'Original' });

      const updated = await service.update(id, {
        title: 'Multi Title',
        coverImageKey: 'series/multi.jpg',
        sortOrder: 9,
      });

      expect(updated).toMatchObject({
        id,
        title: 'Multi Title',
        coverImageKey: 'series/multi.jpg',
        sortOrder: 9,
      });
    });

    it('rejects an empty body with 400 EMPTY_SERIES_UPDATE', async () => {
      const id = `${testIdPrefix}-update-empty`;
      await service.create({ id, title: 'Original' });

      let caught: unknown;
      try {
        await service.update(id, {});
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AppException);
      expect((caught as AppException).code).toBe(
        AppErrorCode.EMPTY_SERIES_UPDATE,
      );

      const persisted = await prisma.series.findUnique({ where: { id } });
      expect(persisted?.title).toBe('Original'); // unchanged
    });

    it('rejects an unknown id with 404 SERIES_NOT_FOUND', async () => {
      await expect(
        service.update(`${testIdPrefix}-does-not-exist`, { title: 'X' }),
      ).rejects.toMatchObject({ code: AppErrorCode.SERIES_NOT_FOUND });
    });
  });
});
