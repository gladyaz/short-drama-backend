import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import type { AuthResponseDto } from './../src/auth/auth.types';
import type { SeriesDto } from './../src/series/series.types';

interface ErrorResponseBody {
  statusCode: number;
  code: string;
  message: string;
}

/**
 * e2e coverage for the Phase 11 (work unit 11E-4) admin-guarded
 * `/admin/series` metadata CRUD, hitting the real HTTP layer against the
 * real test database. `DEV_TOOLS_ENABLED=true` for the whole file, needed
 * only to bootstrap an admin user via the 11B-2 dev-grant route (a real
 * admin-provisioning flow does not exist yet). This suite never touches the
 * `Video` table or the 40 pre-existing seed rows — `Series` is a wholly
 * separate, additive table with no FK to `Video`.
 */
describe('Series admin CRUD (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminAccessToken: string;
  let nonAdminAccessToken: string;

  const emailPrefix = 'series-e2e-spec+11e4';
  const seriesIdPrefix = `${emailPrefix}-series`;
  const uniqueEmail = (label: string): string =>
    `${emailPrefix}-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  beforeAll(async () => {
    process.env.DEV_TOOLS_ENABLED = 'true';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new AppExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);

    const adminRegister = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: uniqueEmail('admin'), password: 'correct-horse-battery' })
      .expect(HttpStatus.CREATED);
    adminAccessToken = (adminRegister.body as AuthResponseDto).accessToken;

    await request(app.getHttpServer())
      .post('/dev/admin/grant-role')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({})
      .expect(HttpStatus.CREATED);

    const userRegister = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: uniqueEmail('user'), password: 'correct-horse-battery' })
      .expect(HttpStatus.CREATED);
    nonAdminAccessToken = (userRegister.body as AuthResponseDto).accessToken;
  });

  afterAll(async () => {
    await prisma.series.deleteMany({
      where: { id: { startsWith: seriesIdPrefix } },
    });
    await prisma.user.deleteMany({
      where: { email: { contains: emailPrefix } },
    });
    await app.close();
    delete process.env.DEV_TOOLS_ENABLED;
  });

  describe('guards', () => {
    it('GET /admin/series returns 401 without a token', async () => {
      await request(app.getHttpServer())
        .get('/admin/series')
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('GET /admin/series returns 403 ADMIN_ROLE_REQUIRED for a non-admin user', async () => {
      const response = await request(app.getHttpServer())
        .get('/admin/series')
        .set('Authorization', `Bearer ${nonAdminAccessToken}`)
        .expect(HttpStatus.FORBIDDEN);

      expect((response.body as ErrorResponseBody).code).toBe(
        'ADMIN_ROLE_REQUIRED',
      );
    });

    it('POST /admin/series returns 401 without a token', async () => {
      await request(app.getHttpServer())
        .post('/admin/series')
        .send({ id: `${seriesIdPrefix}-guard-post`, title: 'Guarded' })
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('POST /admin/series returns 403 ADMIN_ROLE_REQUIRED for a non-admin user', async () => {
      const response = await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${nonAdminAccessToken}`)
        .send({ id: `${seriesIdPrefix}-guard-post-403`, title: 'Guarded' })
        .expect(HttpStatus.FORBIDDEN);

      expect((response.body as ErrorResponseBody).code).toBe(
        'ADMIN_ROLE_REQUIRED',
      );
    });

    it('PATCH /admin/series/:id returns 401 without a token', async () => {
      await request(app.getHttpServer())
        .patch(`/admin/series/${seriesIdPrefix}-guard-patch`)
        .send({ title: 'New' })
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('PATCH /admin/series/:id returns 403 ADMIN_ROLE_REQUIRED for a non-admin user', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/admin/series/${seriesIdPrefix}-guard-patch-403`)
        .set('Authorization', `Bearer ${nonAdminAccessToken}`)
        .send({ title: 'New' })
        .expect(HttpStatus.FORBIDDEN);

      expect((response.body as ErrorResponseBody).code).toBe(
        'ADMIN_ROLE_REQUIRED',
      );
    });
  });

  describe('POST /admin/series (create)', () => {
    it('creates a series and returns a SeriesDto', async () => {
      const id = `${seriesIdPrefix}-create-basic`;

      const response = await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id, title: 'Basic Series' })
        .expect(HttpStatus.CREATED);

      const body = response.body as SeriesDto;
      expect(body).toMatchObject({
        id,
        title: 'Basic Series',
        coverImageKey: null,
        sortOrder: 0,
      });
      expect(typeof body.createdAt).toBe('string');
      expect(typeof body.updatedAt).toBe('string');
    });

    it('creates a series with optional coverImageKey and sortOrder', async () => {
      const id = `${seriesIdPrefix}-create-optional`;

      const response = await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          id,
          title: 'Optional Series',
          coverImageKey: 'a/b.jpg',
          sortOrder: 4,
        })
        .expect(HttpStatus.CREATED);

      const body = response.body as SeriesDto;
      expect(body.coverImageKey).toBe('a/b.jpg');
      expect(body.sortOrder).toBe(4);
    });

    it('returns 409 SERIES_ALREADY_EXISTS for a duplicate id (clean error, not a raw DB exception)', async () => {
      const id = `${seriesIdPrefix}-create-dup`;
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id, title: 'First' })
        .expect(HttpStatus.CREATED);

      const response = await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id, title: 'Second' })
        .expect(HttpStatus.CONFLICT);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('SERIES_ALREADY_EXISTS');

      const persisted = await prisma.series.findUnique({ where: { id } });
      expect(persisted?.title).toBe('First');
    });

    it('returns 400 when title is missing', async () => {
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id: `${seriesIdPrefix}-create-missing-title` })
        .expect(HttpStatus.BAD_REQUEST);
    });

    it('returns 400 when id is missing', async () => {
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ title: 'No Id' })
        .expect(HttpStatus.BAD_REQUEST);
    });

    it('returns 400 for a non-whitelisted extra field', async () => {
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          id: `${seriesIdPrefix}-create-extra`,
          title: 'Extra',
          notARealField: 'nope',
        })
        .expect(HttpStatus.BAD_REQUEST);
    });

    it('returns 400 for a negative sortOrder', async () => {
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          id: `${seriesIdPrefix}-create-negative-sort`,
          title: 'Neg',
          sortOrder: -1,
        })
        .expect(HttpStatus.BAD_REQUEST);
    });
  });

  describe('GET /admin/series (list)', () => {
    const listPrefix = `${seriesIdPrefix}-list`;

    it('lists created rows in deterministic order (sortOrder then id)', async () => {
      const idB = `${listPrefix}-b-tiebreak`;
      const idA = `${listPrefix}-a-tiebreak`;
      const idFirst = `${listPrefix}-first`;

      // Created out of alpha/sortOrder order to prove ordering isn't
      // insertion order. idA/idB share sortOrder 3 (tie-break by id asc);
      // idFirst has a lower sortOrder (1), so it always sorts first
      // regardless of id.
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id: idB, title: 'B', sortOrder: 3 })
        .expect(HttpStatus.CREATED);
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id: idA, title: 'A', sortOrder: 3 })
        .expect(HttpStatus.CREATED);
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id: idFirst, title: 'First', sortOrder: 1 })
        .expect(HttpStatus.CREATED);

      const response = await request(app.getHttpServer())
        .get('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.OK);

      const ids = (response.body as SeriesDto[])
        .map((s) => s.id)
        .filter((id) => id.startsWith(listPrefix));

      expect(ids).toEqual([idFirst, idA, idB]);
    });
  });

  describe('PATCH /admin/series/:id (update)', () => {
    const patchPrefix = `${seriesIdPrefix}-patch`;

    async function createFixture(
      id: string,
      overrides: Partial<{ coverImageKey: string; sortOrder: number }> = {},
    ): Promise<void> {
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          id,
          title: `Patch fixture ${id}`,
          coverImageKey: overrides.coverImageKey,
          sortOrder: overrides.sortOrder,
        })
        .expect(HttpStatus.CREATED);
    }

    it('updates a single field and preserves the others', async () => {
      const id = `${patchPrefix}-single`;
      await createFixture(id, { coverImageKey: 'orig.jpg', sortOrder: 2 });

      const response = await request(app.getHttpServer())
        .patch(`/admin/series/${id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ title: 'Updated Title' })
        .expect(HttpStatus.OK);

      const body = response.body as SeriesDto;
      expect(body.title).toBe('Updated Title');
      expect(body.coverImageKey).toBe('orig.jpg');
      expect(body.sortOrder).toBe(2);
    });

    it('bumps updatedAt on a successful update', async () => {
      const id = `${patchPrefix}-bump`;
      const createResponse = await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id, title: 'Original' })
        .expect(HttpStatus.CREATED);
      const created = createResponse.body as SeriesDto;

      await new Promise((resolve) => setTimeout(resolve, 10));

      const response = await request(app.getHttpServer())
        .patch(`/admin/series/${id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ title: 'Bumped' })
        .expect(HttpStatus.OK);

      const updated = response.body as SeriesDto;
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(
        new Date(created.updatedAt).getTime(),
      );
      expect(updated.createdAt).toBe(created.createdAt);
    });

    it('updates multiple fields at once', async () => {
      const id = `${patchPrefix}-multi`;
      await createFixture(id);

      const response = await request(app.getHttpServer())
        .patch(`/admin/series/${id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ title: 'Multi', coverImageKey: 'multi.jpg', sortOrder: 7 })
        .expect(HttpStatus.OK);

      expect(response.body).toMatchObject({
        id,
        title: 'Multi',
        coverImageKey: 'multi.jpg',
        sortOrder: 7,
      });
    });

    it('returns 400 EMPTY_SERIES_UPDATE for an empty body', async () => {
      const id = `${patchPrefix}-empty`;
      await createFixture(id);

      const response = await request(app.getHttpServer())
        .patch(`/admin/series/${id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({})
        .expect(HttpStatus.BAD_REQUEST);

      expect((response.body as ErrorResponseBody).code).toBe(
        'EMPTY_SERIES_UPDATE',
      );
    });

    it('returns 400 and leaves the row untouched when id is included in the body (immutable, whitelist-rejected)', async () => {
      const id = `${patchPrefix}-immutable-id`;
      await createFixture(id);

      const response = await request(app.getHttpServer())
        .patch(`/admin/series/${id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id: `${id}-changed`, title: 'Should Not Apply' })
        .expect(HttpStatus.BAD_REQUEST);

      expect((response.body as ErrorResponseBody).code).toBe('HTTP_ERROR');

      const persisted = await prisma.series.findUnique({ where: { id } });
      expect(persisted?.title).toBe(`Patch fixture ${id}`); // unchanged
      const changed = await prisma.series.findUnique({
        where: { id: `${id}-changed` },
      });
      expect(changed).toBeNull();
    });

    it('returns 400 for a non-whitelisted extra field', async () => {
      const id = `${patchPrefix}-extra-field`;
      await createFixture(id);

      await request(app.getHttpServer())
        .patch(`/admin/series/${id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ notARealField: 'nope' })
        .expect(HttpStatus.BAD_REQUEST);
    });

    it('returns 400 for an over-long title (>200 chars)', async () => {
      const id = `${patchPrefix}-long-title`;
      await createFixture(id);

      await request(app.getHttpServer())
        .patch(`/admin/series/${id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ title: 'x'.repeat(201) })
        .expect(HttpStatus.BAD_REQUEST);
    });

    it('returns 404 SERIES_NOT_FOUND for a nonexistent id', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/admin/series/${patchPrefix}-does-not-exist`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ title: 'New Title' })
        .expect(HttpStatus.NOT_FOUND);

      expect((response.body as ErrorResponseBody).code).toBe(
        'SERIES_NOT_FOUND',
      );
    });
  });

  /**
   * Work unit 11E-4 migration additivity / no-regression: confirms the new
   * `Series` table is real (create/list already prove this above) and that
   * the pre-existing `Video` table / public `/videos/feed` are completely
   * unaffected. Deliberately checks a specific known seed row (not a global
   * `prisma.video.count()`), matching the existing
   * `test/videos.e2e-spec.ts` "migration additivity" precedent — other e2e
   * suites create/delete their own namespaced `Video` fixtures concurrently
   * (Jest runs `.e2e-spec.ts` files in parallel worker processes against
   * the same test database), so a global row-count assertion here would be
   * flaky by construction, not a real regression signal.
   */
  describe('migration additivity — Video/feed untouched', () => {
    const knownSeedVideoId = 'video-104-01';

    it('a known pre-existing seed video row is untouched and still published', async () => {
      const seedVideo = await prisma.video.findUnique({
        where: { id: knownSeedVideoId },
      });

      expect(seedVideo).not.toBeNull();
      expect(seedVideo?.lifecycleState).toBe('published');
      expect(seedVideo?.seriesId).toBeTruthy();
    });

    it('the public /videos/feed still serves the known seed video, unaffected by the Series table', async () => {
      const feedResponse = await request(app.getHttpServer())
        .get('/videos/feed')
        .expect(HttpStatus.OK);

      const feedIds = (feedResponse.body as Array<{ id: string }>).map(
        (v) => v.id,
      );
      expect(feedIds).toContain(knownSeedVideoId);
    });

    it('GET /videos/:id for the known seed video still returns the unchanged public VideoResponseDto shape', async () => {
      const response = await request(app.getHttpServer())
        .get(`/videos/${knownSeedVideoId}`)
        .expect(HttpStatus.OK);

      const body = response.body as Record<string, unknown>;
      // The public shape (video.types.ts) is untouched by this work unit —
      // no `Series`-derived field ever appears on it.
      expect(body).not.toHaveProperty('accessTierOverride');
      expect(body).not.toHaveProperty('coverImageKey');
      expect(body.id).toBe(knownSeedVideoId);
    });
  });
});
