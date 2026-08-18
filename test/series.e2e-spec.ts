import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { StorageService } from './../src/storage/storage.service';
import { e2eSuiteBootBudgetMs } from './../src/common/testing/e2e-boot-budget.helpers';
import {
  TEST_FIXTURE_NAMESPACE,
  fixtureEmail,
} from './../src/common/testing/fixture-namespace.helpers';
import {
  createPresignedGetUrlMock,
  createPresignedPutUrlMock,
  resetPresignedGetUrlMock,
} from './../src/common/testing/storage-mock.helpers';
import { MAX_SERIES_COVER_UPLOAD_BYTES } from './../src/series/series-cover.constants';
import type { AuthResponseDto } from './../src/auth/auth.types';
import type {
  SeriesDto,
  SeriesWithCoverDto,
} from './../src/series/series.types';

interface ErrorResponseBody {
  statusCode: number;
  code: string;
  message: string;
}

interface CreateCoverUploadResponseBody {
  upload: { url: string; key: string; expiresAt: string };
}

/**
 * Series test-isolation slice. This suite's `beforeAll` boots the full Nest
 * `AppModule` and then registers TWO users through the real HTTP stack — two
 * REAL cost-factor-12 `bcryptjs` hashes on top of module construction,
 * `app.init()`, and database round trips. It was left at Jest's inherited
 * 5000ms default, which was never a decision anyone made about this suite,
 * and which measurement shows is smaller than the work itself once several
 * Jest workers boot concurrently.
 *
 * It only fails when the machine is busy — i.e. during exactly the parallel
 * full-backend gate this slice exists to make trustworthy — which is why it
 * read as an unrelated flake. Reproduced under a controlled parallel load as
 * `thrown: "Exceeded timeout of 5000 ms for a hook"`, failing all 88 tests
 * in this file at once, every one of them for a reason unrelated to what it
 * asserts; the pre-slice baseline reproduced it in 6 of 6 runs. Nothing here
 * asserts how LONG admin bootstrap takes.
 *
 * `e2eSuiteBootBudgetMs(2)` — the measured cold-boot budget plus two hashes
 * (`register` admin, `register` non-admin; `/dev/admin/grant-role` performs
 * none). A harness hang-detector budget, NOT a business-security timeout:
 * no production timeout, token lifetime, lockout window, or throttle window
 * is affected. See `src/common/testing/e2e-boot-budget.helpers.ts`.
 */
jest.setTimeout(e2eSuiteBootBudgetMs(2));

/**
 * e2e coverage for the Phase 11 (work unit 11E-4, extended in 11F-1)
 * admin-guarded `/admin/series` metadata surface, hitting the real HTTP
 * layer against the real test database. `DEV_TOOLS_ENABLED=true` for the
 * whole file, needed only to bootstrap an admin user via the 11B-2
 * dev-grant route (a real admin-provisioning flow does not exist yet).
 * `Series` is a wholly separate, additive table with no FK to `Video` — the
 * ONLY place this suite touches `Video` is the namespaced fixtures the
 * "DELETE /admin/series/:id (guarded hard delete)" tests below create
 * directly via `prisma.video.create`, to exercise the published-episode
 * guard; the 40 pre-existing seed rows are never touched.
 *
 * Work unit "SERIES COVER UPLOAD BACKEND CONTRACT" (approved 2026-08-14):
 * `StorageService` is overridden with a jest mock for the entire suite
 * (mirroring `test/admin-media.e2e-spec.ts`'s and
 * `test/series-public.e2e-spec.ts`'s established `.overrideProvider`
 * pattern) — no test here makes a real R2/S3 call.
 */
describe('Series admin CRUD (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminAccessToken: string;
  let nonAdminAccessToken: string;
  let mockStorageService: {
    createPresignedPutUrl: jest.Mock;
    createPresignedGetUrl: jest.Mock;
    headObject: jest.Mock;
  };

  // Series test-isolation slice: was the hardcoded literal
  // `'series-e2e-spec+11e4'`, byte-identical in every worktree of this repo,
  // so any two concurrent Jest runs sharing `short_drama_test` collided on
  // these fixture ids and deleted each other's in-flight rows mid-test —
  // the same defect the Auth family already fixed. See
  // `src/common/testing/fixture-namespace.helpers.ts`.
  const emailPrefix = TEST_FIXTURE_NAMESPACE;
  const seriesIdPrefix = `${emailPrefix}-series`;
  const uniqueEmail = (label: string): string => fixtureEmail(`se-${label}`);

  async function createVideoFixture(
    id: string,
    seriesId: string,
    lifecycleState: string,
  ): Promise<void> {
    await prisma.video.create({
      data: {
        id,
        seriesId,
        title: `E2E fixture ${id}`,
        episodeNumber: 1,
        channelName: 'E2E Channel',
        caption: 'E2E fixture caption',
        category: 'drama',
        storageKey: '',
        sourceLanguage: 'zh',
        hasEmbeddedIndonesianSubtitle: true,
        likeCount: 0,
        lifecycleState,
      },
    });
  }

  beforeAll(async () => {
    process.env.DEV_TOOLS_ENABLED = 'true';

    // Both presign mocks echo the REAL `key` argument back and derive their
    // URL from it, exactly like the real `StorageService` methods — several
    // tests below rely on `upload.key` in the HTTP response being the REAL
    // server-generated key, not a canned fixture value. Shared with every
    // other Series spec via `storage-mock.helpers.ts`.
    mockStorageService = {
      createPresignedPutUrl: createPresignedPutUrlMock(),
      createPresignedGetUrl: createPresignedGetUrlMock(),
      headObject: jest.fn(),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(StorageService)
      .useValue(mockStorageService)
      .compile();

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

  afterEach(() => {
    // This suite builds its mocks ONCE in `beforeAll`, so — unlike the unit
    // specs, which get a fresh mock per test — overrides genuinely can leak
    // here and must be undone. `mockClear` alone leaves an unconsumed
    // `mockResolvedValueOnce` queued for the next test; a bare `mockReset`
    // on the GET mock would strip its default implementation and make it
    // return `undefined`, which is exactly the crash this slice removed.
    mockStorageService.createPresignedPutUrl.mockClear();
    resetPresignedGetUrlMock(mockStorageService.createPresignedGetUrl);
    mockStorageService.headObject.mockReset();
  });

  afterAll(async () => {
    // Work unit 11F-1: the guarded hard-delete tests create namespaced
    // `Video` fixtures — clean those up too, alongside every `Series` row
    // this suite creates. None of the 40 pre-existing seed rows match this
    // prefix.
    await prisma.video.deleteMany({
      where: { seriesId: { startsWith: seriesIdPrefix } },
    });
    await prisma.series.deleteMany({
      where: { id: { startsWith: seriesIdPrefix } },
    });
    await prisma.user.deleteMany({
      where: { email: { startsWith: emailPrefix } },
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

    it('GET /admin/series/:id returns 401 without a token', async () => {
      await request(app.getHttpServer())
        .get(`/admin/series/${seriesIdPrefix}-guard-getbyid`)
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('GET /admin/series/:id returns 403 ADMIN_ROLE_REQUIRED for a non-admin user', async () => {
      const response = await request(app.getHttpServer())
        .get(`/admin/series/${seriesIdPrefix}-guard-getbyid-403`)
        .set('Authorization', `Bearer ${nonAdminAccessToken}`)
        .expect(HttpStatus.FORBIDDEN);

      expect((response.body as ErrorResponseBody).code).toBe(
        'ADMIN_ROLE_REQUIRED',
      );
    });

    it('POST /admin/series/:id/archive returns 401 without a token', async () => {
      await request(app.getHttpServer())
        .post(`/admin/series/${seriesIdPrefix}-guard-archive/archive`)
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('POST /admin/series/:id/archive returns 403 ADMIN_ROLE_REQUIRED for a non-admin user', async () => {
      const response = await request(app.getHttpServer())
        .post(`/admin/series/${seriesIdPrefix}-guard-archive-403/archive`)
        .set('Authorization', `Bearer ${nonAdminAccessToken}`)
        .expect(HttpStatus.FORBIDDEN);

      expect((response.body as ErrorResponseBody).code).toBe(
        'ADMIN_ROLE_REQUIRED',
      );
    });

    it('POST /admin/series/:id/unarchive returns 401 without a token', async () => {
      await request(app.getHttpServer())
        .post(`/admin/series/${seriesIdPrefix}-guard-unarchive/unarchive`)
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('POST /admin/series/:id/unarchive returns 403 ADMIN_ROLE_REQUIRED for a non-admin user', async () => {
      const response = await request(app.getHttpServer())
        .post(`/admin/series/${seriesIdPrefix}-guard-unarchive-403/unarchive`)
        .set('Authorization', `Bearer ${nonAdminAccessToken}`)
        .expect(HttpStatus.FORBIDDEN);

      expect((response.body as ErrorResponseBody).code).toBe(
        'ADMIN_ROLE_REQUIRED',
      );
    });

    it('DELETE /admin/series/:id returns 401 without a token', async () => {
      await request(app.getHttpServer())
        .delete(`/admin/series/${seriesIdPrefix}-guard-delete`)
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('DELETE /admin/series/:id returns 403 ADMIN_ROLE_REQUIRED for a non-admin user', async () => {
      const response = await request(app.getHttpServer())
        .delete(`/admin/series/${seriesIdPrefix}-guard-delete-403`)
        .set('Authorization', `Bearer ${nonAdminAccessToken}`)
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

    it('excludes archived series by default (work unit 11F-1)', async () => {
      const activeId = `${listPrefix}-archive-active`;
      const archivedId = `${listPrefix}-archive-archived`;
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id: activeId, title: 'Active' })
        .expect(HttpStatus.CREATED);
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id: archivedId, title: 'Archived' })
        .expect(HttpStatus.CREATED);
      await request(app.getHttpServer())
        .post(`/admin/series/${archivedId}/archive`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.OK);

      const response = await request(app.getHttpServer())
        .get('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.OK);

      const ids = (response.body as SeriesDto[]).map((s) => s.id);
      expect(ids).toContain(activeId);
      expect(ids).not.toContain(archivedId);
    });

    it('includes archived series when includeArchived=true is passed', async () => {
      const activeId = `${listPrefix}-includearchived-active`;
      const archivedId = `${listPrefix}-includearchived-archived`;
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id: activeId, title: 'Active' })
        .expect(HttpStatus.CREATED);
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id: archivedId, title: 'Archived' })
        .expect(HttpStatus.CREATED);
      await request(app.getHttpServer())
        .post(`/admin/series/${archivedId}/archive`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.OK);

      const response = await request(app.getHttpServer())
        .get('/admin/series')
        .query({ includeArchived: 'true' })
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.OK);

      const ids = (response.body as SeriesDto[]).map((s) => s.id);
      expect(ids).toContain(activeId);
      expect(ids).toContain(archivedId);
    });

    it('returns 400 for an invalid includeArchived value', async () => {
      await request(app.getHttpServer())
        .get('/admin/series')
        .query({ includeArchived: 'yes' })
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.BAD_REQUEST);
    });
  });

  describe('GET /admin/series/:id (read-detail)', () => {
    const detailPrefix = `${seriesIdPrefix}-detail`;

    it('returns 200 with the SeriesDto for an existing series', async () => {
      const id = `${detailPrefix}-found`;
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id, title: 'Detail Fixture', sortOrder: 3 })
        .expect(HttpStatus.CREATED);

      const response = await request(app.getHttpServer())
        .get(`/admin/series/${id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.OK);

      const body = response.body as SeriesDto;
      expect(body).toMatchObject({
        id,
        title: 'Detail Fixture',
        sortOrder: 3,
        archivedAt: null,
      });
    });

    it('returns 404 SERIES_NOT_FOUND for an unknown id', async () => {
      const response = await request(app.getHttpServer())
        .get(`/admin/series/${detailPrefix}-does-not-exist`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.NOT_FOUND);

      expect((response.body as ErrorResponseBody).code).toBe(
        'SERIES_NOT_FOUND',
      );
    });
  });

  describe('POST /admin/series/:id/archive and /unarchive', () => {
    const archivePrefix = `${seriesIdPrefix}-archive-crud`;

    it('archive sets archivedAt on the returned SeriesDto', async () => {
      const id = `${archivePrefix}-basic`;
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id, title: 'Archive Me' })
        .expect(HttpStatus.CREATED);

      const response = await request(app.getHttpServer())
        .post(`/admin/series/${id}/archive`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.OK);

      const body = response.body as SeriesDto;
      expect(body.id).toBe(id);
      expect(body.archivedAt).not.toBeNull();

      // GET /admin/series/:id reflects the archived state directly.
      const detail = await request(app.getHttpServer())
        .get(`/admin/series/${id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.OK);
      expect((detail.body as SeriesDto).archivedAt).toBe(body.archivedAt);
    });

    it('archive is idempotent (calling it twice does not error)', async () => {
      const id = `${archivePrefix}-idempotent`;
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id, title: 'Idempotent Archive' })
        .expect(HttpStatus.CREATED);

      await request(app.getHttpServer())
        .post(`/admin/series/${id}/archive`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.OK);

      const second = await request(app.getHttpServer())
        .post(`/admin/series/${id}/archive`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.OK);

      expect((second.body as SeriesDto).archivedAt).not.toBeNull();
    });

    it('unarchive clears archivedAt back to null', async () => {
      const id = `${archivePrefix}-unarchive`;
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id, title: 'Unarchive Me' })
        .expect(HttpStatus.CREATED);
      await request(app.getHttpServer())
        .post(`/admin/series/${id}/archive`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.OK);

      const response = await request(app.getHttpServer())
        .post(`/admin/series/${id}/unarchive`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.OK);

      expect((response.body as SeriesDto).archivedAt).toBeNull();

      // Reflected in the default (excludes-archived) list again.
      const listResponse = await request(app.getHttpServer())
        .get('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.OK);
      const ids = (listResponse.body as SeriesDto[]).map((s) => s.id);
      expect(ids).toContain(id);
    });

    it('returns 404 SERIES_NOT_FOUND for archive on an unknown id', async () => {
      const response = await request(app.getHttpServer())
        .post(`/admin/series/${archivePrefix}-does-not-exist/archive`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.NOT_FOUND);

      expect((response.body as ErrorResponseBody).code).toBe(
        'SERIES_NOT_FOUND',
      );
    });

    it('returns 404 SERIES_NOT_FOUND for unarchive on an unknown id', async () => {
      const response = await request(app.getHttpServer())
        .post(`/admin/series/${archivePrefix}-does-not-exist/unarchive`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.NOT_FOUND);

      expect((response.body as ErrorResponseBody).code).toBe(
        'SERIES_NOT_FOUND',
      );
    });
  });

  describe('DELETE /admin/series/:id (guarded hard delete)', () => {
    const deletePrefix = `${seriesIdPrefix}-delete`;

    it('refuses with 409 SERIES_HAS_PUBLISHED_EPISODES when a published episode exists for that seriesId', async () => {
      const id = `${deletePrefix}-has-published`;
      const videoId = `${deletePrefix}-published-video`;
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id, title: 'Has Published Episode' })
        .expect(HttpStatus.CREATED);
      await createVideoFixture(videoId, id, 'published');

      const response = await request(app.getHttpServer())
        .delete(`/admin/series/${id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.CONFLICT);

      expect((response.body as ErrorResponseBody).code).toBe(
        'SERIES_HAS_PUBLISHED_EPISODES',
      );

      // Nothing was deleted or modified — the Series row and the Video
      // row's seriesId/lifecycleState are both untouched.
      const persistedSeries = await prisma.series.findUnique({
        where: { id },
      });
      expect(persistedSeries).not.toBeNull();
      const persistedVideo = await prisma.video.findUnique({
        where: { id: videoId },
      });
      expect(persistedVideo?.seriesId).toBe(id);
      expect(persistedVideo?.lifecycleState).toBe('published');
    });

    it('is allowed when no published episode exists, and leaves the Video row(s) for that seriesId completely unchanged', async () => {
      const id = `${deletePrefix}-no-published`;
      const draftVideoId = `${deletePrefix}-draft-video`;
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id, title: 'No Published Episode' })
        .expect(HttpStatus.CREATED);
      await createVideoFixture(draftVideoId, id, 'draft');

      const beforeDelete = await prisma.video.findUnique({
        where: { id: draftVideoId },
      });

      await request(app.getHttpServer())
        .delete(`/admin/series/${id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.NO_CONTENT);

      const persistedSeries = await prisma.series.findUnique({
        where: { id },
      });
      expect(persistedSeries).toBeNull();

      // The Video row for this seriesId is completely unchanged — the
      // episode's seriesId (relationship) and every other field are
      // preserved exactly, proving the Series delete never touches Video.
      const afterDelete = await prisma.video.findUnique({
        where: { id: draftVideoId },
      });
      expect(afterDelete).toEqual(beforeDelete);
      expect(afterDelete?.seriesId).toBe(id);
    });

    it('is allowed when the series has no Video rows at all', async () => {
      const id = `${deletePrefix}-no-videos`;
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id, title: 'No Episodes' })
        .expect(HttpStatus.CREATED);

      await request(app.getHttpServer())
        .delete(`/admin/series/${id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.NO_CONTENT);

      const persisted = await prisma.series.findUnique({ where: { id } });
      expect(persisted).toBeNull();
    });

    it('returns 404 SERIES_NOT_FOUND for an unknown id', async () => {
      const response = await request(app.getHttpServer())
        .delete(`/admin/series/${deletePrefix}-does-not-exist`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.NOT_FOUND);

      expect((response.body as ErrorResponseBody).code).toBe(
        'SERIES_NOT_FOUND',
      );
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
   * Work unit "SERIES COVER UPLOAD BACKEND CONTRACT" (approved 2026-08-14):
   * `POST /admin/series/:id/cover` — presign-init.
   */
  describe('POST /admin/series/:id/cover (cover upload presign-init)', () => {
    const coverPrefix = `${seriesIdPrefix}-cover-init`;
    const validBody = { contentType: 'image/jpeg', sizeBytes: 2048 };

    async function createFixture(id: string): Promise<void> {
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id, title: `Cover fixture ${id}` })
        .expect(HttpStatus.CREATED);
    }

    it('returns 401 without a token', async () => {
      await request(app.getHttpServer())
        .post(`/admin/series/${coverPrefix}-guard/cover`)
        .send(validBody)
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('returns 403 ADMIN_ROLE_REQUIRED for a non-admin user', async () => {
      const response = await request(app.getHttpServer())
        .post(`/admin/series/${coverPrefix}-guard-403/cover`)
        .set('Authorization', `Bearer ${nonAdminAccessToken}`)
        .send(validBody)
        .expect(HttpStatus.FORBIDDEN);

      expect((response.body as ErrorResponseBody).code).toBe(
        'ADMIN_ROLE_REQUIRED',
      );
    });

    it('returns 404 SERIES_NOT_FOUND for an unknown series, minting no presigned URL', async () => {
      const response = await request(app.getHttpServer())
        .post(`/admin/series/${coverPrefix}-does-not-exist/cover`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send(validBody)
        .expect(HttpStatus.NOT_FOUND);

      expect((response.body as ErrorResponseBody).code).toBe(
        'SERIES_NOT_FOUND',
      );
      expect(mockStorageService.createPresignedPutUrl).not.toHaveBeenCalled();
    });

    it('mints a presigned PUT URL for a server-generated, series-scoped key and does NOT persist coverImageKey', async () => {
      const id = `${coverPrefix}-basic`;
      await createFixture(id);

      const response = await request(app.getHttpServer())
        .post(`/admin/series/${id}/cover`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send(validBody)
        .expect(HttpStatus.CREATED);

      const body = response.body as CreateCoverUploadResponseBody;
      expect(Object.keys(body)).toEqual(['upload']);
      expect(Object.keys(body.upload).sort()).toEqual([
        'expiresAt',
        'key',
        'url',
      ]);
      // `id` itself is percent-encoded inside the key (see
      // `series-cover-key.util.ts`) — this suite's own `seriesIdPrefix`
      // contains a `+` (from `emailPrefix`), so the raw `id` is never a
      // literal substring of the key; compare against the encoded form.
      expect(
        body.upload.key.startsWith(
          `admin-series/${encodeURIComponent(id)}/cover/`,
        ),
      ).toBe(true);

      const persisted = await prisma.series.findUnique({ where: { id } });
      expect(persisted?.coverImageKey).toBeNull();
    });

    it.each(['image/jpeg', 'image/png', 'image/webp'])(
      'accepts the allowed content type %s',
      async (contentType) => {
        const id = `${coverPrefix}-mime-${contentType.replace('/', '-')}`;
        await createFixture(id);

        await request(app.getHttpServer())
          .post(`/admin/series/${id}/cover`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .send({ contentType, sizeBytes: 2048 })
          .expect(HttpStatus.CREATED);
      },
    );

    it.each(['image/svg+xml', 'video/mp4', 'application/pdf', 'image/gif'])(
      'rejects the disallowed content type %s with 400',
      async (contentType) => {
        const id = `${coverPrefix}-mime-reject-${contentType.replace(/[/+]/g, '-')}`;
        await createFixture(id);

        await request(app.getHttpServer())
          .post(`/admin/series/${id}/cover`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .send({ contentType, sizeBytes: 2048 })
          .expect(HttpStatus.BAD_REQUEST);
      },
    );

    it('accepts sizeBytes exactly at MAX_SERIES_COVER_UPLOAD_BYTES', async () => {
      const id = `${coverPrefix}-size-at-max`;
      await createFixture(id);

      await request(app.getHttpServer())
        .post(`/admin/series/${id}/cover`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          contentType: 'image/jpeg',
          sizeBytes: MAX_SERIES_COVER_UPLOAD_BYTES,
        })
        .expect(HttpStatus.CREATED);
    });

    it('rejects sizeBytes one byte over MAX_SERIES_COVER_UPLOAD_BYTES with 400', async () => {
      const id = `${coverPrefix}-size-over-max`;
      await createFixture(id);

      await request(app.getHttpServer())
        .post(`/admin/series/${id}/cover`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          contentType: 'image/jpeg',
          sizeBytes: MAX_SERIES_COVER_UPLOAD_BYTES + 1,
        })
        .expect(HttpStatus.BAD_REQUEST);
    });

    it('rejects a missing contentType with 400', async () => {
      const id = `${coverPrefix}-missing-contenttype`;
      await createFixture(id);

      await request(app.getHttpServer())
        .post(`/admin/series/${id}/cover`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ sizeBytes: 2048 })
        .expect(HttpStatus.BAD_REQUEST);
    });

    it('rejects a missing sizeBytes with 400', async () => {
      const id = `${coverPrefix}-missing-sizebytes`;
      await createFixture(id);

      await request(app.getHttpServer())
        .post(`/admin/series/${id}/cover`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ contentType: 'image/jpeg' })
        .expect(HttpStatus.BAD_REQUEST);
    });

    it('rejects a client-supplied key field (server-generated only) with 400', async () => {
      const id = `${coverPrefix}-reject-client-key`;
      await createFixture(id);

      await request(app.getHttpServer())
        .post(`/admin/series/${id}/cover`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ ...validBody, key: 'admin-series/attacker-chosen/cover/x' })
        .expect(HttpStatus.BAD_REQUEST);
    });
  });

  /**
   * Work unit "SERIES COVER UPLOAD BACKEND CONTRACT": `POST
   * /admin/series/:id/cover/complete` — verify + persist.
   */
  describe('POST /admin/series/:id/cover/complete (cover upload completion)', () => {
    const completePrefix = `${seriesIdPrefix}-cover-complete`;
    const coverContentType = 'image/png';
    const coverSizeBytes = 4096;

    async function initUpload(id: string): Promise<string> {
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id, title: `Complete fixture ${id}` })
        .expect(HttpStatus.CREATED);

      const initResponse = await request(app.getHttpServer())
        .post(`/admin/series/${id}/cover`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ contentType: coverContentType, sizeBytes: coverSizeBytes })
        .expect(HttpStatus.CREATED);

      return (initResponse.body as CreateCoverUploadResponseBody).upload.key;
    }

    function mockHeadObjectOnce(
      contentLength: number,
      contentType: string,
    ): void {
      mockStorageService.headObject.mockResolvedValueOnce({
        contentLength,
        contentType,
      });
    }

    it('returns 401 without a token', async () => {
      await request(app.getHttpServer())
        .post(`/admin/series/${completePrefix}-guard/cover/complete`)
        .send({ key: 'admin-series/x/cover/x' })
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('returns 403 ADMIN_ROLE_REQUIRED for a non-admin user', async () => {
      const response = await request(app.getHttpServer())
        .post(`/admin/series/${completePrefix}-guard-403/cover/complete`)
        .set('Authorization', `Bearer ${nonAdminAccessToken}`)
        .send({ key: 'admin-series/x/cover/x' })
        .expect(HttpStatus.FORBIDDEN);

      expect((response.body as ErrorResponseBody).code).toBe(
        'ADMIN_ROLE_REQUIRED',
      );
    });

    it('returns 404 SERIES_NOT_FOUND for an unknown series', async () => {
      const response = await request(app.getHttpServer())
        .post(`/admin/series/${completePrefix}-does-not-exist/cover/complete`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ key: 'admin-series/x/cover/x' })
        .expect(HttpStatus.NOT_FOUND);

      expect((response.body as ErrorResponseBody).code).toBe(
        'SERIES_NOT_FOUND',
      );
    });

    it('rejects a key belonging to a different series with 400 SERIES_COVER_KEY_INVALID, never calling headObject', async () => {
      const id = `${completePrefix}-wrong-owner`;
      await initUpload(id);

      const response = await request(app.getHttpServer())
        .post(`/admin/series/${id}/cover/complete`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          key: 'admin-series/some-other-series/cover/00000000-0000-4000-8000-000000000000',
        })
        .expect(HttpStatus.BAD_REQUEST);

      expect((response.body as ErrorResponseBody).code).toBe(
        'SERIES_COVER_KEY_INVALID',
      );
      expect(mockStorageService.headObject).not.toHaveBeenCalled();
    });

    it('rejects when the object does not exist (headObject returns null) with 400 MEDIA_FILE_NOT_FOUND, leaving coverImageKey untouched', async () => {
      const id = `${completePrefix}-missing-object`;
      const key = await initUpload(id);
      mockStorageService.headObject.mockResolvedValueOnce(null);

      const response = await request(app.getHttpServer())
        .post(`/admin/series/${id}/cover/complete`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ key })
        .expect(HttpStatus.BAD_REQUEST);

      expect((response.body as ErrorResponseBody).code).toBe(
        'MEDIA_FILE_NOT_FOUND',
      );
      const persisted = await prisma.series.findUnique({ where: { id } });
      expect(persisted?.coverImageKey).toBeNull();
    });

    it('rejects a disallowed real content type (headObject) with 409 SERIES_COVER_CONTENT_TYPE_NOT_ALLOWED', async () => {
      const id = `${completePrefix}-bad-mime`;
      const key = await initUpload(id);
      mockHeadObjectOnce(coverSizeBytes, 'image/svg+xml');

      const response = await request(app.getHttpServer())
        .post(`/admin/series/${id}/cover/complete`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ key })
        .expect(HttpStatus.CONFLICT);

      expect((response.body as ErrorResponseBody).code).toBe(
        'SERIES_COVER_CONTENT_TYPE_NOT_ALLOWED',
      );
    });

    it('rejects a real size over MAX_SERIES_COVER_UPLOAD_BYTES (headObject) with 409 SERIES_COVER_SIZE_OUT_OF_BOUND', async () => {
      const id = `${completePrefix}-too-big`;
      const key = await initUpload(id);
      mockHeadObjectOnce(MAX_SERIES_COVER_UPLOAD_BYTES + 1, coverContentType);

      const response = await request(app.getHttpServer())
        .post(`/admin/series/${id}/cover/complete`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ key })
        .expect(HttpStatus.CONFLICT);

      expect((response.body as ErrorResponseBody).code).toBe(
        'SERIES_COVER_SIZE_OUT_OF_BOUND',
      );
    });

    it('persists Series.coverImageKey only after verification succeeds, and returns a signed coverUrl', async () => {
      const id = `${completePrefix}-success`;
      const key = await initUpload(id);
      mockHeadObjectOnce(coverSizeBytes, coverContentType);

      const response = await request(app.getHttpServer())
        .post(`/admin/series/${id}/cover/complete`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ key })
        .expect(HttpStatus.OK);

      const body = response.body as SeriesWithCoverDto;
      expect(body.coverImageKey).toBe(key);
      expect(body.coverUrl).toContain(encodeURIComponent(key));

      const persisted = await prisma.series.findUnique({ where: { id } });
      expect(persisted?.coverImageKey).toBe(key);
    });

    it('is idempotent: completing the same key twice both return 200 with the same coverImageKey', async () => {
      const id = `${completePrefix}-idempotent`;
      const key = await initUpload(id);

      mockHeadObjectOnce(coverSizeBytes, coverContentType);
      await request(app.getHttpServer())
        .post(`/admin/series/${id}/cover/complete`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ key })
        .expect(HttpStatus.OK);

      mockHeadObjectOnce(coverSizeBytes, coverContentType);
      const second = await request(app.getHttpServer())
        .post(`/admin/series/${id}/cover/complete`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ key })
        .expect(HttpStatus.OK);

      expect((second.body as SeriesWithCoverDto).coverImageKey).toBe(key);
    });

    /**
     * Acceptance criterion 3 (replace semantics), proven end-to-end over
     * real HTTP: a second upload attempt whose verification FAILS must
     * never clear or overwrite the already-verified first cover; a second
     * upload that verifies SUCCEEDS must replace it with the new key.
     */
    describe('replace semantics', () => {
      it('a failed replacement attempt leaves the existing coverImageKey completely untouched', async () => {
        const id = `${completePrefix}-replace-fail-preserves-old`;
        const firstKey = await initUpload(id);
        mockHeadObjectOnce(coverSizeBytes, coverContentType);
        await request(app.getHttpServer())
          .post(`/admin/series/${id}/cover/complete`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .send({ key: firstKey })
          .expect(HttpStatus.OK);

        const secondInit = await request(app.getHttpServer())
          .post(`/admin/series/${id}/cover`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .send({ contentType: coverContentType, sizeBytes: coverSizeBytes })
          .expect(HttpStatus.CREATED);
        const secondKey = (secondInit.body as CreateCoverUploadResponseBody)
          .upload.key;
        mockStorageService.headObject.mockResolvedValueOnce(null); // never landed

        await request(app.getHttpServer())
          .post(`/admin/series/${id}/cover/complete`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .send({ key: secondKey })
          .expect(HttpStatus.BAD_REQUEST);

        const persisted = await prisma.series.findUnique({ where: { id } });
        expect(persisted?.coverImageKey).toBe(firstKey);
      });

      it('a successfully verified replacement swaps in the new key', async () => {
        const id = `${completePrefix}-replace-success`;
        const firstKey = await initUpload(id);
        mockHeadObjectOnce(coverSizeBytes, coverContentType);
        await request(app.getHttpServer())
          .post(`/admin/series/${id}/cover/complete`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .send({ key: firstKey })
          .expect(HttpStatus.OK);

        const secondInit = await request(app.getHttpServer())
          .post(`/admin/series/${id}/cover`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .send({ contentType: coverContentType, sizeBytes: coverSizeBytes })
          .expect(HttpStatus.CREATED);
        const secondKey = (secondInit.body as CreateCoverUploadResponseBody)
          .upload.key;
        mockHeadObjectOnce(coverSizeBytes, coverContentType);

        const response = await request(app.getHttpServer())
          .post(`/admin/series/${id}/cover/complete`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .send({ key: secondKey })
          .expect(HttpStatus.OK);

        expect((response.body as SeriesWithCoverDto).coverImageKey).toBe(
          secondKey,
        );
        const persisted = await prisma.series.findUnique({ where: { id } });
        expect(persisted?.coverImageKey).toBe(secondKey);
        expect(persisted?.coverImageKey).not.toBe(firstKey);
      });
    });

    /**
     * Fix cycle 1 (2026-08-15): closes a reviewer-reproduced HIGH finding,
     * end-to-end over real HTTP — a stale/replayed `POST .../cover/complete`
     * carrying an OLD, already-superseded key could previously silently
     * succeed (`200`) and revert a legitimate replace, or un-clear an
     * explicit `PATCH { coverImageKey: null }`. (Non-vacuity for this
     * behavior was independently proven at the unit-test layer —
     * `src/series/series.service.spec.ts`'s matching describe block — by
     * temporarily reverting `SeriesService` to its pre-fix-cycle-1 logic and
     * confirming those tests fail against it, then restoring the fix
     * byte-identical; the same `SeriesService` code path is exercised here.)
     */
    describe('stale/replayed key rejection (fix cycle 1 — SERIES_COVER_KEY_SUPERSEDED)', () => {
      it('REPRO 1: rejects a replay of an old key after a legitimate replace, leaving the NEW cover untouched', async () => {
        const id = `${completePrefix}-replay-after-replace`;
        const firstKey = await initUpload(id);
        mockHeadObjectOnce(coverSizeBytes, coverContentType);
        await request(app.getHttpServer())
          .post(`/admin/series/${id}/cover/complete`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .send({ key: firstKey })
          .expect(HttpStatus.OK);

        const secondInit = await request(app.getHttpServer())
          .post(`/admin/series/${id}/cover`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .send({ contentType: coverContentType, sizeBytes: coverSizeBytes })
          .expect(HttpStatus.CREATED);
        const secondKey = (secondInit.body as CreateCoverUploadResponseBody)
          .upload.key;
        mockHeadObjectOnce(coverSizeBytes, coverContentType);
        await request(app.getHttpServer())
          .post(`/admin/series/${id}/cover/complete`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .send({ key: secondKey })
          .expect(HttpStatus.OK);

        // Replay the FIRST (now-superseded) key.
        const replay = await request(app.getHttpServer())
          .post(`/admin/series/${id}/cover/complete`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .send({ key: firstKey })
          .expect(HttpStatus.CONFLICT);

        expect((replay.body as ErrorResponseBody).code).toBe(
          'SERIES_COVER_KEY_SUPERSEDED',
        );
        const persisted = await prisma.series.findUnique({ where: { id } });
        expect(persisted?.coverImageKey).toBe(secondKey);
        expect(persisted?.coverImageKey).not.toBe(firstKey);
      });

      it('REPRO 2: rejects a replay of a completed key after an explicit PATCH-null clear, leaving coverImageKey null', async () => {
        const id = `${completePrefix}-replay-after-null-clear`;
        const key = await initUpload(id);
        mockHeadObjectOnce(coverSizeBytes, coverContentType);
        await request(app.getHttpServer())
          .post(`/admin/series/${id}/cover/complete`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .send({ key })
          .expect(HttpStatus.OK);

        await request(app.getHttpServer())
          .patch(`/admin/series/${id}`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .send({ coverImageKey: null })
          .expect(HttpStatus.OK);

        // Replay the just-cleared key.
        const replay = await request(app.getHttpServer())
          .post(`/admin/series/${id}/cover/complete`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .send({ key })
          .expect(HttpStatus.CONFLICT);

        expect((replay.body as ErrorResponseBody).code).toBe(
          'SERIES_COVER_KEY_SUPERSEDED',
        );
        const persisted = await prisma.series.findUnique({ where: { id } });
        expect(persisted?.coverImageKey).toBeNull();
      });

      it('presign overwrites pending: completing an older mint is rejected once a newer mint supersedes it, never calling headObject', async () => {
        const id = `${completePrefix}-mint-overwrite`;
        await request(app.getHttpServer())
          .post('/admin/series')
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .send({ id, title: `Mint overwrite ${id}` })
          .expect(HttpStatus.CREATED);

        const firstInit = await request(app.getHttpServer())
          .post(`/admin/series/${id}/cover`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .send({ contentType: coverContentType, sizeBytes: coverSizeBytes })
          .expect(HttpStatus.CREATED);
        const firstKey = (firstInit.body as CreateCoverUploadResponseBody)
          .upload.key;

        const secondInit = await request(app.getHttpServer())
          .post(`/admin/series/${id}/cover`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .send({ contentType: coverContentType, sizeBytes: coverSizeBytes })
          .expect(HttpStatus.CREATED);
        const secondKey = (secondInit.body as CreateCoverUploadResponseBody)
          .upload.key;
        expect(secondKey).not.toBe(firstKey);

        const response = await request(app.getHttpServer())
          .post(`/admin/series/${id}/cover/complete`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .send({ key: firstKey })
          .expect(HttpStatus.CONFLICT);

        expect((response.body as ErrorResponseBody).code).toBe(
          'SERIES_COVER_KEY_SUPERSEDED',
        );
        expect(mockStorageService.headObject).not.toHaveBeenCalled();

        const persisted = await prisma.series.findUnique({ where: { id } });
        expect(persisted?.coverImageKey).toBeNull();
        expect(persisted?.pendingCoverImageKey).toBe(secondKey);
      });

      it('PATCH { coverImageKey: null } also clears pendingCoverImageKey', async () => {
        const id = `${completePrefix}-null-clears-pending`;
        const key = await initUpload(id);
        const beforeClear = await prisma.series.findUnique({
          where: { id },
        });
        expect(beforeClear?.pendingCoverImageKey).toBe(key);

        await request(app.getHttpServer())
          .patch(`/admin/series/${id}`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .send({ coverImageKey: null })
          .expect(HttpStatus.OK);

        const afterClear = await prisma.series.findUnique({ where: { id } });
        expect(afterClear?.pendingCoverImageKey).toBeNull();
      });
    });

    /**
     * Slice "SERIES COVER UPLOAD CONCURRENCY / TOCTOU HARDENING"
     * (2026-08-18): API-level proof of the semantics the service-level
     * compare-and-set enforces. These tests deliberately do NOT attempt a
     * real, nondeterministic HTTP race — the actual interleaving (a removal
     * or a replacement landing WHILE a completion is inside its storage
     * verification window) is proven deterministically in
     * `src/series/series.service.spec.ts`'s "atomic final persistence"
     * block. What e2e adds is that the observable, end-to-end contract
     * matches: once a newer admin action has landed, the older pending key
     * is refused over real HTTP with the documented status/code, and the
     * cover state a client can read back is the newer action's, never the
     * loser's.
     */
    describe('concurrency semantics: a superseded pending intent can never win (slice 2026-08-18)', () => {
      it('an uncompleted pending key is refused 409 after Remove, and the cover stays null', async () => {
        const id = `${completePrefix}-pending-after-remove`;
        const key = await initUpload(id);

        await request(app.getHttpServer())
          .patch(`/admin/series/${id}`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .send({ coverImageKey: null })
          .expect(HttpStatus.OK);

        const response = await request(app.getHttpServer())
          .post(`/admin/series/${id}/cover/complete`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .send({ key })
          .expect(HttpStatus.CONFLICT);

        expect((response.body as ErrorResponseBody).code).toBe(
          'SERIES_COVER_KEY_SUPERSEDED',
        );

        const persisted = await prisma.series.findUnique({ where: { id } });
        expect(persisted?.coverImageKey).toBeNull();
        expect(persisted?.pendingCoverImageKey).toBeNull();

        const readBack = await request(app.getHttpServer())
          .get(`/admin/series/${id}`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .expect(HttpStatus.OK);
        expect((readBack.body as SeriesWithCoverDto).coverImageKey).toBeNull();
        expect((readBack.body as SeriesWithCoverDto).coverUrl).toBeNull();
      });

      it('an uncompleted pending key is refused 409 once a newer presign supersedes it, leaving the live cover AND the newer pending intent intact', async () => {
        const id = `${completePrefix}-pending-superseded-by-newer`;
        const liveKey = await initUpload(id);
        mockHeadObjectOnce(coverSizeBytes, coverContentType);
        await request(app.getHttpServer())
          .post(`/admin/series/${id}/cover/complete`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .send({ key: liveKey })
          .expect(HttpStatus.OK);

        const initA = await request(app.getHttpServer())
          .post(`/admin/series/${id}/cover`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .send({ contentType: coverContentType, sizeBytes: coverSizeBytes })
          .expect(HttpStatus.CREATED);
        const keyA = (initA.body as CreateCoverUploadResponseBody).upload.key;

        const initB = await request(app.getHttpServer())
          .post(`/admin/series/${id}/cover`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .send({ contentType: coverContentType, sizeBytes: coverSizeBytes })
          .expect(HttpStatus.CREATED);
        const keyB = (initB.body as CreateCoverUploadResponseBody).upload.key;
        expect(keyB).not.toBe(keyA);

        const response = await request(app.getHttpServer())
          .post(`/admin/series/${id}/cover/complete`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .send({ key: keyA })
          .expect(HttpStatus.CONFLICT);

        expect((response.body as ErrorResponseBody).code).toBe(
          'SERIES_COVER_KEY_SUPERSEDED',
        );

        const persisted = await prisma.series.findUnique({ where: { id } });
        // The live cover is untouched by the loser...
        expect(persisted?.coverImageKey).toBe(liveKey);
        // ...and so is the newer pending intent it lost to.
        expect(persisted?.pendingCoverImageKey).toBe(keyB);

        // The winner can still finish normally afterwards.
        mockHeadObjectOnce(coverSizeBytes, coverContentType);
        const completedB = await request(app.getHttpServer())
          .post(`/admin/series/${id}/cover/complete`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .send({ key: keyB })
          .expect(HttpStatus.OK);
        expect((completedB.body as SeriesWithCoverDto).coverImageKey).toBe(
          keyB,
        );

        const afterB = await prisma.series.findUnique({ where: { id } });
        expect(afterB?.coverImageKey).toBe(keyB);
        expect(afterB?.pendingCoverImageKey).toBeNull();
      });
    });
  });

  /**
   * Work unit "SERIES COVER UPLOAD BACKEND CONTRACT", acceptance criterion
   * 5: `GET /admin/series` / `GET /admin/series/:id` expose a signed
   * `coverUrl` (null-honest, including for an archived/episode-less
   * series).
   */
  describe('Admin read: coverUrl exposure', () => {
    const readPrefix = `${seriesIdPrefix}-cover-read`;

    it('GET /admin/series exposes coverUrl: null for a series with no coverImageKey', async () => {
      const id = `${readPrefix}-list-null`;
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id, title: 'No Cover' })
        .expect(HttpStatus.CREATED);

      const response = await request(app.getHttpServer())
        .get('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.OK);

      const found = (response.body as SeriesWithCoverDto[]).find(
        (s) => s.id === id,
      );
      expect(found?.coverUrl).toBeNull();
    });

    it('GET /admin/series/:id exposes a resolved coverUrl when coverImageKey is set, including for an archived series', async () => {
      const id = `${readPrefix}-detail-archived`;
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          id,
          title: 'Archived With Cover',
          coverImageKey: 'admin-series/x/cover/archived-detail-uuid',
        })
        .expect(HttpStatus.CREATED);
      await request(app.getHttpServer())
        .post(`/admin/series/${id}/archive`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.OK);

      const response = await request(app.getHttpServer())
        .get(`/admin/series/${id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.OK);

      const body = response.body as SeriesWithCoverDto;
      expect(body.archivedAt).not.toBeNull();
      expect(body.coverUrl).toContain('archived-detail-uuid');
    });
  });

  /**
   * Work unit "SERIES COVER UPLOAD BACKEND CONTRACT", acceptance criterion
   * 4: `PATCH /admin/series/:id { coverImageKey }` three distinct semantics
   * — `undefined` (omitted) = unchanged, `null` = explicit clear, `string`
   * = existing set/replace behavior — proven at the real HTTP/DTO layer
   * (mirrors `series.service.spec.ts`'s equivalent unit-level proof).
   */
  describe('PATCH /admin/series/:id — coverImageKey null/undefined/string semantics', () => {
    const patchCoverPrefix = `${seriesIdPrefix}-patch-cover`;

    it('omitting coverImageKey leaves the existing value unchanged', async () => {
      const id = `${patchCoverPrefix}-undefined`;
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id, title: 'Original', coverImageKey: 'series/keep.jpg' })
        .expect(HttpStatus.CREATED);

      const response = await request(app.getHttpServer())
        .patch(`/admin/series/${id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ title: 'Renamed' })
        .expect(HttpStatus.OK);

      expect((response.body as SeriesDto).coverImageKey).toBe(
        'series/keep.jpg',
      );
    });

    it('an explicit null clears coverImageKey', async () => {
      const id = `${patchCoverPrefix}-null`;
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id, title: 'Original', coverImageKey: 'series/clear.jpg' })
        .expect(HttpStatus.CREATED);

      const response = await request(app.getHttpServer())
        .patch(`/admin/series/${id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ coverImageKey: null })
        .expect(HttpStatus.OK);

      expect((response.body as SeriesDto).coverImageKey).toBeNull();
      const persisted = await prisma.series.findUnique({ where: { id } });
      expect(persisted?.coverImageKey).toBeNull();
    });

    it('a string sets/replaces coverImageKey (existing behavior, unchanged)', async () => {
      const id = `${patchCoverPrefix}-string`;
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id, title: 'Original', coverImageKey: 'series/old.jpg' })
        .expect(HttpStatus.CREATED);

      const response = await request(app.getHttpServer())
        .patch(`/admin/series/${id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ coverImageKey: 'series/new.jpg' })
        .expect(HttpStatus.OK);

      expect((response.body as SeriesDto).coverImageKey).toBe('series/new.jpg');
    });
  });

  /**
   * Work unit "SERIES COVER UPLOAD BACKEND CONTRACT", acceptance criterion
   * 6: the public catalog and feed stay byte-compatible, and known rows are
   * unaffected by this work unit's additive changes. Note: this
   * repository's `short_drama_test` database (used by this e2e run) seeds
   * only the 40 real drama rows (no `qa_fixture` rows) — the "42 = 40 drama
   * + 2 qa_fixture" figure describes `short_drama_dev` specifically, a
   * pre-existing difference between the two databases that predates and is
   * unrelated to this work unit.
   *
   * Series test-isolation slice — WHY THE GLOBAL COUNTS ARE GONE. This test
   * used to snapshot `prisma.video.count()` / `prisma.series.count()` with
   * NO `where` clause before and after the cover-upload flow and assert the
   * totals matched. A BEFORE/AFTER pair is self-contained only with respect
   * to the ENVIRONMENT; it is not self-contained with respect to TIME.
   * Jest runs `.e2e-spec.ts` files in parallel worker processes against this
   * same database, and `videos.e2e-spec.ts` / `admin-media.e2e-spec.ts`
   * legitimately create and delete their own `Video` rows — and
   * `series-public.e2e-spec.ts` its own `Series` rows — inside that window.
   * Observed in a full e2e gate as `expected same count / got 101 vs 96`,
   * roughly 1 run in 6.
   *
   * Reproduced deterministically before this fix, rather than waiting for a
   * lucky interleaving: with a controlled inserter creating rows for an
   * UNRELATED series while this test ran, `expect(afterVideoCount).toBe(
   * beforeVideoCount)` failed `Expected: 518 / Received: 520`, and the
   * sibling `expect(afterSeriesCount).toBe(beforeSeriesCount + 1)` failed
   * `Expected: 158 / Received: 160` — while every scoped invariant below
   * held throughout.
   *
   * "Nobody anywhere in this database created a `Video`" was never the
   * invariant this test meant. The real invariant is narrower and true:
   * this work unit's cover-upload flow creates exactly one `Series` row (the
   * fixture) and creates, deletes, or mutates NO `Video` row. Both are
   * asserted below against rows this suite OWNS.
   *
   * The witness row is this suite's own fixture rather than a real seed
   * episode for the same reason: `interactions.e2e-spec.ts` legitimately
   * likes and unlikes the seeded `video-104-01` in a parallel worker, so a
   * field-by-field comparison of the seed rows fails on a moving
   * `likeCount` (observed as `83` -> `82` in a full gate) — a shared-row
   * assertion is no safer than a global count just because it is precise.
   */
  describe('regression — public catalog/feed byte-compatible; DB counts untouched', () => {
    it('GET /videos/feed and GET /series are unaffected by this work unit’s cover-upload flow', async () => {
      // A `Video` row this suite OWNS, used as the witness for the
      // "no Video side effects" invariant below. It deliberately lives under
      // a DIFFERENT namespaced series than the cover fixture, so the
      // "never appears on the public catalog" assertion further down still
      // describes a genuinely episode-less series.
      const witnessSeriesId = `${seriesIdPrefix}-regression-witness`;
      const witnessVideoId = `${witnessSeriesId}-ep1`;
      await prisma.series.create({
        data: { id: witnessSeriesId, title: 'Regression Witness' },
      });
      await createVideoFixture(witnessVideoId, witnessSeriesId, 'published');

      // Scoped to rows this suite owns — never the whole table, and never a
      // shared seed row. Both are immune to a parallel worker touching
      // anything else.
      const beforeOwnSeriesCount = await prisma.series.count({
        where: { id: { startsWith: seriesIdPrefix } },
      });
      const beforeOwnVideoCount = await prisma.video.count({
        where: { seriesId: { startsWith: seriesIdPrefix } },
      });
      // Negative side-effect proof by EXACT VALUE, not by table length: the
      // witness row is captured field-by-field and re-read after the flow,
      // so a mutation is caught even if the row COUNT is unchanged.
      const witnessBefore = await prisma.video.findUniqueOrThrow({
        where: { id: witnessVideoId },
      });

      const id = `${seriesIdPrefix}-regression-cover`;
      await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id, title: 'Regression Check' })
        .expect(HttpStatus.CREATED);
      const initResponse = await request(app.getHttpServer())
        .post(`/admin/series/${id}/cover`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ contentType: 'image/jpeg', sizeBytes: 2048 })
        .expect(HttpStatus.CREATED);
      mockStorageService.headObject.mockResolvedValueOnce({
        contentLength: 2048,
        contentType: 'image/jpeg',
      });
      await request(app.getHttpServer())
        .post(`/admin/series/${id}/cover/complete`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          key: (initResponse.body as CreateCoverUploadResponseBody).upload.key,
        })
        .expect(HttpStatus.OK);

      // The 4 real curated series' public shape is unaffected (this new,
      // namespaced fixture has zero qualifying episodes, so it never
      // appears on the public surface at all — see `PublicSeriesService`'s
      // "qualifying episode" rule).
      const publicListResponse = await request(app.getHttpServer())
        .get('/series')
        .expect(HttpStatus.OK);
      const publicIds = (
        publicListResponse.body as { items: { id: string }[] }
      ).items.map((s) => s.id);
      expect(publicIds).not.toContain(id);

      const feedResponse = await request(app.getHttpServer())
        .get('/videos/feed')
        .expect(HttpStatus.OK);
      expect(Array.isArray(feedResponse.body)).toBe(true);

      // This suite's own `Series` rows grew by exactly 1 — the cover fixture
      // just created — and the flow created or deleted no `Video` row of
      // this suite's.
      const afterOwnSeriesCount = await prisma.series.count({
        where: { id: { startsWith: seriesIdPrefix } },
      });
      const afterOwnVideoCount = await prisma.video.count({
        where: { seriesId: { startsWith: seriesIdPrefix } },
      });
      expect(afterOwnSeriesCount).toBe(beforeOwnSeriesCount + 1);
      expect(afterOwnVideoCount).toBe(beforeOwnVideoCount);

      // ...and mutated no field of one, byte for byte.
      const witnessAfter = await prisma.video.findUniqueOrThrow({
        where: { id: witnessVideoId },
      });
      expect(witnessAfter).toEqual(witnessBefore);
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

  /**
   * Work unit 11F-1 migration additivity: confirms the new `archivedAt`
   * column on `Series` is real and additive (defaults to `null`, matching
   * the schema comment) without touching `Video` at all, and that the
   * 40-video seed catalog is still exactly 40 rows.
   */
  describe('migration additivity — Series.archivedAt column', () => {
    it('a newly created Series row defaults archivedAt to null', async () => {
      const id = `${seriesIdPrefix}-migration-archivedat-default`;

      const response = await request(app.getHttpServer())
        .post('/admin/series')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ id, title: 'Default ArchivedAt' })
        .expect(HttpStatus.CREATED);

      expect((response.body as SeriesDto).archivedAt).toBeNull();

      const persisted = await prisma.series.findUnique({ where: { id } });
      expect(persisted?.archivedAt).toBeNull();
    });

    /**
     * SEED DEPENDENCY — INTENTIONAL, AND THE ONLY ONE LEFT IN THIS FILE.
     *
     * This assertion is a migration-additivity check: it exists precisely to
     * prove the seeded catalog is exactly the 40 rows the seed script
     * creates, so a data migration that silently added or dropped one would
     * be caught. Replacing it with a locally-created fixture would delete
     * the only thing it tests, so the prerequisite is documented and
     * verified explicitly instead.
     *
     * PREREQUISITE: `short_drama_test` must be seeded (`DATABASE_URL=
     * $DATABASE_URL_TEST npm run db:seed`). Parallel-safe: `video-` is the
     * seed script's own id prefix and no test suite creates ids under it —
     * every suite namespaces its `Video` fixtures (`videos.e2e-spec.ts` and
     * `series*.e2e-spec.ts` under their per-run `TEST_FIXTURE_NAMESPACE`,
     * `admin-media.e2e-spec.ts` under the service's `media-` prefix), so a
     * concurrent worker cannot move this number.
     */
    it('the 40-video seed catalog is untouched by the archivedAt migration', async () => {
      const seedVideoCount = await prisma.video.count({
        where: { id: { startsWith: 'video-' } },
      });

      if (seedVideoCount === 0) {
        throw new Error(
          'short_drama_test contains no `video-` seed rows: this migration-' +
            'additivity check needs the seeded catalog. Run ' +
            '`DATABASE_URL=$DATABASE_URL_TEST npm run db:seed` and re-run.',
        );
      }
      expect(seedVideoCount).toBe(40);
    });
  });
});
