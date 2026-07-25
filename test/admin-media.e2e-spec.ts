import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { StorageService } from './../src/storage/storage.service';
import type { AuthResponseDto } from './../src/auth/auth.types';
import type {
  AdminMediaDto,
  AdminMediaListResponseDto,
} from './../src/media/media.types';

interface ErrorResponseBody {
  statusCode: number;
  code: string;
  message: string;
}

interface CreateUploadResponseBody {
  media: { id: string; lifecycleState: string; objectStorageKey: string };
  upload: { url: string; key: string; expiresAt: string };
}

/**
 * e2e coverage for the Phase 11 (work unit 11B-3) admin-guarded
 * `/admin/media` upload/publish API, hitting the real HTTP layer against
 * the real test database. `StorageService` is overridden with a jest mock
 * for the entire suite — no test here makes a real R2/S3 call.
 * `DEV_TOOLS_ENABLED=true` for the whole file, needed only to bootstrap an
 * admin user via the 11B-2 dev-grant route (a real admin-provisioning flow
 * does not exist yet).
 */
describe('Admin Media (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminAccessToken: string;
  let nonAdminAccessToken: string;
  let mockStorageService: {
    createPresignedPutUrl: jest.Mock;
    createPresignedGetUrl: jest.Mock;
    headObject: jest.Mock;
    objectExists: jest.Mock;
    deleteObject: jest.Mock;
    buildPublicUrl: jest.Mock;
  };

  const emailPrefix = 'admin-media-e2e-spec+11b3';
  const testSeriesId = `${emailPrefix}-series`;
  const uniqueEmail = (label: string): string =>
    `${emailPrefix}-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  const validCreateBody = {
    seriesId: testSeriesId,
    title: 'E2E Admin Media',
    episodeNumber: 1,
    channelName: 'E2E Channel',
    caption: 'E2E caption',
    category: 'drama',
    sourceLanguage: 'zh',
    hasEmbeddedIndonesianSubtitle: true,
  };

  beforeAll(async () => {
    process.env.DEV_TOOLS_ENABLED = 'true';

    mockStorageService = {
      createPresignedPutUrl: jest.fn().mockResolvedValue({
        url: 'https://signed.example.test/put',
        key: 'admin-media/mock/source',
        expiresAt: new Date(Date.now() + 60_000),
      }),
      createPresignedGetUrl: jest.fn(),
      headObject: jest.fn(),
      objectExists: jest.fn().mockResolvedValue(true),
      deleteObject: jest.fn(),
      buildPublicUrl: jest.fn(),
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

  afterAll(async () => {
    // `startsWith`, not an exact match: the work unit 11E-1 `list` tests
    // below namespace their fixtures under `${testSeriesId}-11e1-*`, so this
    // one sweep also cleans those up alongside the `testSeriesId` rows the
    // "admin happy path" tests above create.
    await prisma.video.deleteMany({
      where: { seriesId: { startsWith: testSeriesId } },
    });
    await prisma.user.deleteMany({
      where: { email: { contains: emailPrefix } },
    });
    await app.close();
    delete process.env.DEV_TOOLS_ENABLED;
  });

  beforeEach(() => {
    mockStorageService.createPresignedPutUrl.mockClear();
    mockStorageService.objectExists.mockClear();
  });

  describe('401 — no token', () => {
    it('POST /admin/media returns 401 without a token', async () => {
      await request(app.getHttpServer())
        .post('/admin/media')
        .send(validCreateBody)
        .expect(HttpStatus.UNAUTHORIZED);
    });
  });

  describe('403 — authenticated but not an admin', () => {
    it('POST /admin/media returns 403 ADMIN_ROLE_REQUIRED for a non-admin user', async () => {
      const response = await request(app.getHttpServer())
        .post('/admin/media')
        .set('Authorization', `Bearer ${nonAdminAccessToken}`)
        .send(validCreateBody)
        .expect(HttpStatus.FORBIDDEN);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('ADMIN_ROLE_REQUIRED');
    });
  });

  describe('400 — metadata validation', () => {
    it('POST /admin/media returns 400 when a required field is missing', async () => {
      const { title: _title, ...missingTitle } = validCreateBody;
      void _title;

      const response = await request(app.getHttpServer())
        .post('/admin/media')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send(missingTitle)
        .expect(HttpStatus.BAD_REQUEST);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('HTTP_ERROR');
    });

    it('POST /admin/media returns 400 for a non-whitelisted extra field', async () => {
      await request(app.getHttpServer())
        .post('/admin/media')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ ...validCreateBody, notARealField: 'nope' })
        .expect(HttpStatus.BAD_REQUEST);
    });

    it('POST /admin/media returns 400 for a wrong-typed field (episodeNumber as a string)', async () => {
      await request(app.getHttpServer())
        .post('/admin/media')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ ...validCreateBody, episodeNumber: 'not-a-number' })
        .expect(HttpStatus.BAD_REQUEST);
    });
  });

  describe('admin happy path', () => {
    let mediaId: string;

    it('creates a draft upload via the mocked StorageService, never a real network call', async () => {
      const response = await request(app.getHttpServer())
        .post('/admin/media')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ ...validCreateBody, contentType: 'video/mp4' })
        .expect(HttpStatus.CREATED);

      const body = response.body as CreateUploadResponseBody;
      mediaId = body.media.id;

      expect(body.media.lifecycleState).toBe('draft');
      expect(body.upload.url).toBe('https://signed.example.test/put');
      expect(mockStorageService.createPresignedPutUrl).toHaveBeenCalledTimes(1);
    });

    it('GET /admin/media/:id returns the admin view of the draft', async () => {
      const response = await request(app.getHttpServer())
        .get(`/admin/media/${mediaId}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.OK);

      const body = response.body as AdminMediaDto;
      expect(body.lifecycleState).toBe('draft');
      // Work unit 11E-3: a freshly created row has no override yet.
      expect(body.accessTierOverride).toBeNull();
    });

    it('the draft is invisible to the public feed and GET /videos/:id', async () => {
      const feedResponse = await request(app.getHttpServer())
        .get('/videos/feed')
        .expect(HttpStatus.OK);
      const feedIds = (feedResponse.body as Array<{ id: string }>).map(
        (v) => v.id,
      );
      expect(feedIds).not.toContain(mediaId);

      await request(app.getHttpServer())
        .get(`/videos/${mediaId}`)
        .expect(HttpStatus.NOT_FOUND);
    });

    it('completes the upload (draft -> ready) once the mocked StorageService confirms the object exists', async () => {
      const response = await request(app.getHttpServer())
        .post(`/admin/media/${mediaId}/complete-upload`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ durationSeconds: 90, width: 1080, height: 1920 })
        .expect(HttpStatus.OK);

      const body = response.body as AdminMediaDto;
      expect(body.lifecycleState).toBe('ready');
      expect(body.durationSeconds).toBe(90);
    });

    it('uploads a cover and a thumbnail', async () => {
      const coverResponse = await request(app.getHttpServer())
        .post(`/admin/media/${mediaId}/cover`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ contentType: 'image/jpeg' })
        .expect(HttpStatus.CREATED);
      expect(
        (coverResponse.body as CreateUploadResponseBody).media.objectStorageKey,
      ).toBeDefined();

      const thumbnailResponse = await request(app.getHttpServer())
        .post(`/admin/media/${mediaId}/thumbnail`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({})
        .expect(HttpStatus.CREATED);
      expect(thumbnailResponse.body).toBeDefined();
    });

    it('publishes the media (ready -> published), then it appears in the public feed', async () => {
      const response = await request(app.getHttpServer())
        .post(`/admin/media/${mediaId}/publish`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({})
        .expect(HttpStatus.OK);

      expect((response.body as AdminMediaDto).lifecycleState).toBe('published');

      const feedResponse = await request(app.getHttpServer())
        .get('/videos/feed')
        .expect(HttpStatus.OK);
      const feedIds = (feedResponse.body as Array<{ id: string }>).map(
        (v) => v.id,
      );
      expect(feedIds).toContain(mediaId);
    });

    it('unpublishes the media (published -> unpublished), then it disappears from the feed again', async () => {
      await request(app.getHttpServer())
        .post(`/admin/media/${mediaId}/unpublish`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({})
        .expect(HttpStatus.OK);

      const feedResponse = await request(app.getHttpServer())
        .get('/videos/feed')
        .expect(HttpStatus.OK);
      const feedIds = (feedResponse.body as Array<{ id: string }>).map(
        (v) => v.id,
      );
      expect(feedIds).not.toContain(mediaId);
    });

    it('rejects an invalid transition (publish again immediately) with a clean 400', async () => {
      const response = await request(app.getHttpServer())
        .post(`/admin/media/${mediaId}/publish`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({})
        .expect(HttpStatus.OK); // unpublished -> published is allowed

      expect((response.body as AdminMediaDto).lifecycleState).toBe('published');

      // publishing an already-published record is not a valid edge.
      const invalidResponse = await request(app.getHttpServer())
        .post(`/admin/media/${mediaId}/publish`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({})
        .expect(HttpStatus.BAD_REQUEST);

      const body = invalidResponse.body as ErrorResponseBody;
      expect(body.code).toBe('INVALID_MEDIA_LIFECYCLE_TRANSITION');
    });

    it('returns 404 VIDEO_NOT_FOUND for an unknown media id', async () => {
      const response = await request(app.getHttpServer())
        .get('/admin/media/does-not-exist')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(HttpStatus.NOT_FOUND);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('VIDEO_NOT_FOUND');
    });
  });

  /**
   * Work unit 11E-1: `GET /admin/media`, the paginated/filterable inventory
   * list across ALL five lifecycle states. Fixtures are written directly via
   * `prisma.video.create` (matching the existing `VideosService`/
   * `interactions.service.spec.ts` precedent for seeding rows an HTTP flow
   * can't easily reach — there is no admin route that transitions a record
   * to `failed`), namespaced under `${testSeriesId}-11e1-*` so `afterAll`'s
   * `startsWith(testSeriesId)` sweep cleans them up alongside every other
   * fixture in this file; none of the 40 seed rows are touched.
   */
  describe('GET /admin/media (list)', () => {
    const listSeriesId = `${testSeriesId}-11e1-list`;
    const otherSeriesId = `${testSeriesId}-11e1-other`;
    const paginationSeriesId = `${testSeriesId}-11e1-pagination`;

    async function createFixture(
      id: string,
      seriesId: string,
      lifecycleState: string,
      sortOrder = 0,
    ): Promise<string> {
      await prisma.video.create({
        data: {
          id,
          seriesId,
          title: `List fixture ${id}`,
          episodeNumber: 1,
          channelName: 'E2E Channel',
          caption: 'List fixture caption',
          category: 'drama',
          storageKey: '',
          sourceLanguage: 'zh',
          hasEmbeddedIndonesianSubtitle: true,
          likeCount: 0,
          lifecycleState,
          sortOrder,
        },
      });
      return id;
    }

    describe('401 — no token', () => {
      it('returns 401 without a token', async () => {
        await request(app.getHttpServer())
          .get('/admin/media')
          .expect(HttpStatus.UNAUTHORIZED);
      });
    });

    describe('403 — authenticated but not an admin', () => {
      it('returns 403 ADMIN_ROLE_REQUIRED for a non-admin user', async () => {
        const response = await request(app.getHttpServer())
          .get('/admin/media')
          .set('Authorization', `Bearer ${nonAdminAccessToken}`)
          .expect(HttpStatus.FORBIDDEN);

        const body = response.body as ErrorResponseBody;
        expect(body.code).toBe('ADMIN_ROLE_REQUIRED');
      });
    });

    describe('lifecycle-state coverage and filters', () => {
      let draftId: string;
      let readyId: string;
      let publishedId: string;
      let unpublishedId: string;
      let failedId: string;
      let otherSeriesFixtureId: string;

      beforeAll(async () => {
        draftId = await createFixture(
          `${listSeriesId}-draft`,
          listSeriesId,
          'draft',
        );
        readyId = await createFixture(
          `${listSeriesId}-ready`,
          listSeriesId,
          'ready',
        );
        publishedId = await createFixture(
          `${listSeriesId}-published`,
          listSeriesId,
          'published',
        );
        unpublishedId = await createFixture(
          `${listSeriesId}-unpublished`,
          listSeriesId,
          'unpublished',
        );
        failedId = await createFixture(
          `${listSeriesId}-failed`,
          listSeriesId,
          'failed',
        );
        otherSeriesFixtureId = await createFixture(
          `${otherSeriesId}-draft`,
          otherSeriesId,
          'draft',
        );
      });

      it('lists media rows across every lifecycle state for the given series', async () => {
        const response = await request(app.getHttpServer())
          .get('/admin/media')
          .query({ seriesId: listSeriesId, pageSize: 50 })
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .expect(HttpStatus.OK);

        const body = response.body as AdminMediaListResponseDto;
        const ids = body.items.map((item) => item.id);

        expect(ids).toEqual(
          expect.arrayContaining([
            draftId,
            readyId,
            publishedId,
            unpublishedId,
            failedId,
          ]),
        );
        expect(ids).not.toContain(otherSeriesFixtureId);
        expect(body.total).toBe(5);
        expect(body.page).toBe(1);
        expect(body.pageSize).toBe(50);
      });

      it('filters by status', async () => {
        const response = await request(app.getHttpServer())
          .get('/admin/media')
          .query({ seriesId: listSeriesId, status: 'failed' })
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .expect(HttpStatus.OK);

        const body = response.body as AdminMediaListResponseDto;
        expect(body.items.map((item) => item.id)).toEqual([failedId]);
        expect(body.total).toBe(1);
      });

      it('rejects an invalid status value with a clean 400', async () => {
        await request(app.getHttpServer())
          .get('/admin/media')
          .query({ status: 'not-a-real-state' })
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .expect(HttpStatus.BAD_REQUEST);
      });

      it('filters by seriesId, excluding rows from other series', async () => {
        const response = await request(app.getHttpServer())
          .get('/admin/media')
          .query({ seriesId: otherSeriesId })
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .expect(HttpStatus.OK);

        const body = response.body as AdminMediaListResponseDto;
        expect(body.items.map((item) => item.id)).toEqual([
          otherSeriesFixtureId,
        ]);
      });

      it('GET /admin/media/:id still resolves correctly (no collision with the collection route)', async () => {
        const response = await request(app.getHttpServer())
          .get(`/admin/media/${draftId}`)
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .expect(HttpStatus.OK);

        expect((response.body as AdminMediaDto).id).toBe(draftId);
        expect((response.body as AdminMediaDto).lifecycleState).toBe('draft');
      });
    });

    describe('pagination', () => {
      let firstId: string;
      let secondId: string;
      let thirdId: string;

      beforeAll(async () => {
        // Identical `sortOrder` (the default, 0) for all three, so ordering
        // falls back to the documented `id` ascending tie-break —
        // deterministic regardless of insertion order.
        firstId = await createFixture(
          `${paginationSeriesId}-a`,
          paginationSeriesId,
          'draft',
        );
        secondId = await createFixture(
          `${paginationSeriesId}-b`,
          paginationSeriesId,
          'draft',
        );
        thirdId = await createFixture(
          `${paginationSeriesId}-c`,
          paginationSeriesId,
          'draft',
        );
      });

      it('respects page/pageSize and reports a correct total', async () => {
        const pageOne = await request(app.getHttpServer())
          .get('/admin/media')
          .query({ seriesId: paginationSeriesId, page: 1, pageSize: 2 })
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .expect(HttpStatus.OK);
        const pageTwo = await request(app.getHttpServer())
          .get('/admin/media')
          .query({ seriesId: paginationSeriesId, page: 2, pageSize: 2 })
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .expect(HttpStatus.OK);

        const bodyOne = pageOne.body as AdminMediaListResponseDto;
        const bodyTwo = pageTwo.body as AdminMediaListResponseDto;

        expect(bodyOne.items).toHaveLength(2);
        expect(bodyTwo.items).toHaveLength(1);
        expect(bodyOne.total).toBe(3);
        expect(bodyTwo.total).toBe(3);
        expect(bodyOne.page).toBe(1);
        expect(bodyTwo.page).toBe(2);
        expect(bodyOne.pageSize).toBe(2);

        const orderedIds = [...bodyOne.items, ...bodyTwo.items].map(
          (item) => item.id,
        );
        expect(orderedIds).toEqual(
          [firstId, secondId, thirdId].sort((a, b) => (a < b ? -1 : 1)),
        );
      });

      it('defaults to page 1 / pageSize 20 when the query omits them', async () => {
        const response = await request(app.getHttpServer())
          .get('/admin/media')
          .query({ seriesId: paginationSeriesId })
          .set('Authorization', `Bearer ${adminAccessToken}`)
          .expect(HttpStatus.OK);

        const body = response.body as AdminMediaListResponseDto;
        expect(body.page).toBe(1);
        expect(body.pageSize).toBe(20);
        expect(body.total).toBe(3);
      });
    });
  });

  /**
   * Work unit 11E-2: `PATCH /admin/media/:id`, a partial metadata edit.
   * Fixtures are namespaced under `${testSeriesId}-11e2-*`, covered by the
   * same `afterAll` `startsWith(testSeriesId)` sweep as every other fixture
   * in this file; none of the 40 seed rows are touched.
   */
  describe('PATCH /admin/media/:id (metadata edit)', () => {
    const patchSeriesId = `${testSeriesId}-11e2-patch`;

    async function createFixture(
      id: string,
      overrides: Partial<{
        lifecycleState: string;
        objectStorageKey: string | null;
        likeCount: number;
        sortOrder: number;
      }> = {},
    ): Promise<string> {
      await prisma.video.create({
        data: {
          id,
          seriesId: patchSeriesId,
          title: `Patch fixture ${id}`,
          episodeNumber: 1,
          channelName: 'E2E Channel',
          caption: 'Patch fixture caption',
          category: 'drama',
          storageKey: '',
          sourceLanguage: 'zh',
          hasEmbeddedIndonesianSubtitle: true,
          likeCount: overrides.likeCount ?? 0,
          lifecycleState: overrides.lifecycleState ?? 'draft',
          objectStorageKey: overrides.objectStorageKey ?? null,
          sortOrder: overrides.sortOrder ?? 0,
        },
      });
      return id;
    }

    describe('401 — no token', () => {
      it('returns 401 without a token', async () => {
        const id = await createFixture(`${patchSeriesId}-401`);
        await request(app.getHttpServer())
          .patch(`/admin/media/${id}`)
          .send({ title: 'New Title' })
          .expect(HttpStatus.UNAUTHORIZED);
      });
    });

    describe('403 — authenticated but not an admin', () => {
      it('returns 403 ADMIN_ROLE_REQUIRED for a non-admin user', async () => {
        const id = await createFixture(`${patchSeriesId}-403`);
        const response = await request(app.getHttpServer())
          .patch(`/admin/media/${id}`)
          .set('Authorization', `Bearer ${nonAdminAccessToken}`)
          .send({ title: 'New Title' })
          .expect(HttpStatus.FORBIDDEN);

        const body = response.body as ErrorResponseBody;
        expect(body.code).toBe('ADMIN_ROLE_REQUIRED');
      });
    });

    it('updates a single field and returns the updated AdminMediaDto', async () => {
      const id = await createFixture(`${patchSeriesId}-single`);

      const response = await request(app.getHttpServer())
        .patch(`/admin/media/${id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ title: 'Updated Title' })
        .expect(HttpStatus.OK);

      const body = response.body as AdminMediaDto;
      expect(body.id).toBe(id);
      expect(body.title).toBe('Updated Title');
      expect(body.caption).toBe('Patch fixture caption');
    });

    it('updates multiple fields at once', async () => {
      const id = await createFixture(`${patchSeriesId}-multi`);

      const response = await request(app.getHttpServer())
        .patch(`/admin/media/${id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          title: 'Multi Title',
          caption: 'Multi caption',
          category: 'comedy',
          channelName: 'Multi Channel',
          sourceLanguage: 'en',
          episodeNumber: 3,
          hasEmbeddedIndonesianSubtitle: false,
        })
        .expect(HttpStatus.OK);

      const body = response.body as AdminMediaDto;
      expect(body).toMatchObject({
        id,
        title: 'Multi Title',
        caption: 'Multi caption',
        category: 'comedy',
        channelName: 'Multi Channel',
        sourceLanguage: 'en',
        episodeNumber: 3,
        hasEmbeddedIndonesianSubtitle: false,
      });
    });

    it('preserves lifecycleState, objectStorageKey, likeCount and sortOrder', async () => {
      const id = await createFixture(`${patchSeriesId}-untouched`, {
        lifecycleState: 'published',
        objectStorageKey: 'admin-media/untouched/source',
        likeCount: 5,
        sortOrder: 3,
      });

      const response = await request(app.getHttpServer())
        .patch(`/admin/media/${id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ title: 'Still Untouched Elsewhere' })
        .expect(HttpStatus.OK);

      const body = response.body as AdminMediaDto;
      expect(body.title).toBe('Still Untouched Elsewhere');
      expect(body.lifecycleState).toBe('published');
      expect(body.objectStorageKey).toBe('admin-media/untouched/source');

      const persisted = await prisma.video.findUnique({ where: { id } });
      expect(persisted?.likeCount).toBe(5);
      expect(persisted?.sortOrder).toBe(3);
      expect(persisted?.lifecycleState).toBe('published');
      expect(persisted?.objectStorageKey).toBe('admin-media/untouched/source');
    });

    it('returns 400 EMPTY_MEDIA_METADATA_UPDATE for an empty body', async () => {
      const id = await createFixture(`${patchSeriesId}-empty`);

      const response = await request(app.getHttpServer())
        .patch(`/admin/media/${id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({})
        .expect(HttpStatus.BAD_REQUEST);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('EMPTY_MEDIA_METADATA_UPDATE');
    });

    it('returns 400 for an unknown/non-whitelisted field', async () => {
      const id = await createFixture(`${patchSeriesId}-unknown-field`);

      await request(app.getHttpServer())
        .patch(`/admin/media/${id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ notARealField: 'nope' })
        .expect(HttpStatus.BAD_REQUEST);
    });

    it('returns 400 when an immutable field is included (e.g. lifecycleState)', async () => {
      const id = await createFixture(`${patchSeriesId}-immutable-field`);

      const response = await request(app.getHttpServer())
        .patch(`/admin/media/${id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ lifecycleState: 'published' })
        .expect(HttpStatus.BAD_REQUEST);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('HTTP_ERROR');

      const persisted = await prisma.video.findUnique({ where: { id } });
      expect(persisted?.lifecycleState).toBe('draft'); // unchanged
    });

    it('returns 400 for an invalid episodeNumber (0, below the Min(1) constraint)', async () => {
      const id = await createFixture(`${patchSeriesId}-bad-episode`);

      await request(app.getHttpServer())
        .patch(`/admin/media/${id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ episodeNumber: 0 })
        .expect(HttpStatus.BAD_REQUEST);
    });

    it('returns 400 for an over-long title (>200 chars)', async () => {
      const id = await createFixture(`${patchSeriesId}-long-title`);

      await request(app.getHttpServer())
        .patch(`/admin/media/${id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ title: 'x'.repeat(201) })
        .expect(HttpStatus.BAD_REQUEST);
    });

    it('returns 404 VIDEO_NOT_FOUND for a nonexistent id', async () => {
      const response = await request(app.getHttpServer())
        .patch('/admin/media/does-not-exist')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ title: 'New Title' })
        .expect(HttpStatus.NOT_FOUND);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('VIDEO_NOT_FOUND');
    });
  });

  /**
   * Work unit 11E-3: `PATCH /admin/media/:id/access-tier`, setting/clearing
   * the per-episode `accessTierOverride`. Fixtures are namespaced under
   * `${testSeriesId}-11e3-*`, covered by the same `afterAll`
   * `startsWith(testSeriesId)` sweep as every other fixture in this file;
   * none of the 40 seed rows are touched. The stream-guard integration
   * itself (does the override actually change 403 vs. non-403 behavior) is
   * covered separately in `test/videos.e2e-spec.ts`, since that requires
   * the `/videos/:id/stream` route, not this admin route.
   */
  describe('PATCH /admin/media/:id/access-tier (access-tier override)', () => {
    const accessTierSeriesId = `${testSeriesId}-11e3-access-tier`;

    async function createFixture(
      id: string,
      overrides: Partial<{ accessTierOverride: string | null }> = {},
    ): Promise<string> {
      await prisma.video.create({
        data: {
          id,
          seriesId: accessTierSeriesId,
          title: `Access-tier fixture ${id}`,
          episodeNumber: 1,
          channelName: 'E2E Channel',
          caption: 'Access-tier fixture caption',
          category: 'drama',
          storageKey: '',
          sourceLanguage: 'zh',
          hasEmbeddedIndonesianSubtitle: true,
          likeCount: 0,
          lifecycleState: 'published',
          accessTierOverride: overrides.accessTierOverride ?? null,
        },
      });
      return id;
    }

    describe('401 — no token', () => {
      it('returns 401 without a token', async () => {
        const id = await createFixture(`${accessTierSeriesId}-401`);
        await request(app.getHttpServer())
          .patch(`/admin/media/${id}/access-tier`)
          .send({ tier: 'premium' })
          .expect(HttpStatus.UNAUTHORIZED);
      });
    });

    describe('403 — authenticated but not an admin', () => {
      it('returns 403 ADMIN_ROLE_REQUIRED for a non-admin user', async () => {
        const id = await createFixture(`${accessTierSeriesId}-403`);
        const response = await request(app.getHttpServer())
          .patch(`/admin/media/${id}/access-tier`)
          .set('Authorization', `Bearer ${nonAdminAccessToken}`)
          .send({ tier: 'premium' })
          .expect(HttpStatus.FORBIDDEN);

        const body = response.body as ErrorResponseBody;
        expect(body.code).toBe('ADMIN_ROLE_REQUIRED');
      });
    });

    it('sets the override to "premium" and returns it on the updated AdminMediaDto', async () => {
      const id = await createFixture(`${accessTierSeriesId}-set-premium`);

      const response = await request(app.getHttpServer())
        .patch(`/admin/media/${id}/access-tier`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ tier: 'premium' })
        .expect(HttpStatus.OK);

      const body = response.body as AdminMediaDto;
      expect(body.id).toBe(id);
      expect(body.accessTierOverride).toBe('premium');

      const persisted = await prisma.video.findUnique({ where: { id } });
      expect(persisted?.accessTierOverride).toBe('premium');
    });

    it('sets the override to "free" and returns it on the updated AdminMediaDto', async () => {
      const id = await createFixture(`${accessTierSeriesId}-set-free`, {
        accessTierOverride: 'premium',
      });

      const response = await request(app.getHttpServer())
        .patch(`/admin/media/${id}/access-tier`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ tier: 'free' })
        .expect(HttpStatus.OK);

      expect((response.body as AdminMediaDto).accessTierOverride).toBe('free');
    });

    it('clears the override with tier: null', async () => {
      const id = await createFixture(`${accessTierSeriesId}-clear`, {
        accessTierOverride: 'premium',
      });

      const response = await request(app.getHttpServer())
        .patch(`/admin/media/${id}/access-tier`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ tier: null })
        .expect(HttpStatus.OK);

      expect((response.body as AdminMediaDto).accessTierOverride).toBeNull();

      const persisted = await prisma.video.findUnique({ where: { id } });
      expect(persisted?.accessTierOverride).toBeNull();
    });

    it('leaves every other field untouched', async () => {
      const id = await createFixture(`${accessTierSeriesId}-untouched`);

      const response = await request(app.getHttpServer())
        .patch(`/admin/media/${id}/access-tier`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ tier: 'premium' })
        .expect(HttpStatus.OK);

      const body = response.body as AdminMediaDto;
      expect(body.title).toBe(`Access-tier fixture ${id}`);
      expect(body.lifecycleState).toBe('published');
      expect(body.episodeNumber).toBe(1);
    });

    it('returns 400 for an invalid tier value', async () => {
      const id = await createFixture(`${accessTierSeriesId}-invalid`);

      await request(app.getHttpServer())
        .patch(`/admin/media/${id}/access-tier`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ tier: 'gold' })
        .expect(HttpStatus.BAD_REQUEST);
    });

    it('returns 400 when the tier field is missing entirely', async () => {
      const id = await createFixture(`${accessTierSeriesId}-missing`);

      await request(app.getHttpServer())
        .patch(`/admin/media/${id}/access-tier`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({})
        .expect(HttpStatus.BAD_REQUEST);
    });

    it('returns 400 for a non-whitelisted extra field', async () => {
      const id = await createFixture(`${accessTierSeriesId}-extra-field`);

      await request(app.getHttpServer())
        .patch(`/admin/media/${id}/access-tier`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ tier: 'premium', notARealField: 'nope' })
        .expect(HttpStatus.BAD_REQUEST);
    });

    it('returns 404 VIDEO_NOT_FOUND for a nonexistent id', async () => {
      const response = await request(app.getHttpServer())
        .patch('/admin/media/does-not-exist/access-tier')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ tier: 'premium' })
        .expect(HttpStatus.NOT_FOUND);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('VIDEO_NOT_FOUND');
    });
  });
});
