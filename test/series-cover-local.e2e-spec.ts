import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { StorageService } from './../src/storage/storage.service';
import { e2eSuiteBootBudgetMs } from './../src/common/testing/e2e-boot-budget.helpers';
import { fixtureMarker } from './../src/common/testing/fixture-namespace.helpers';
import { createPresignedGetUrlMock } from './../src/common/testing/storage-mock.helpers';
import { buildSeriesCoverObjectKey } from './../src/series/series-cover-key.util';
import type { SeriesDetailPublicDto } from './../src/series/series-public.types';

jest.setTimeout(e2eSuiteBootBudgetMs());

/**
 * Work unit "LOCAL SERIES COVER ARTWORK": end-to-end coverage of
 * `GET /series/:id/cover`, the `local` driver's public artwork surface.
 *
 * WHAT THIS SUITE PROVES, and why each matters:
 *
 *  - real BYTES come back, byte-identical to what was ingested — a route that
 *    returns 200 with a truncated or wrong body would satisfy a status-code
 *    assertion and still show a broken image;
 *  - the `Content-Type` is derived from the file's own leading bytes;
 *  - `Cross-Origin-Resource-Policy: cross-origin` is present, which is the
 *    single header without which an Expo Web page on `localhost:8081` gets a
 *    successful response the browser then silently discards;
 *  - that header is set on THIS route only — the global `helmet()` default is
 *    not weakened for the rest of the API;
 *  - no credential is required, because an `<img>` cannot send one;
 *  - every not-servable condition answers a uniform 404, including a key that
 *    this series' own upload flow could not have minted;
 *  - traversal cannot escape the approved root.
 *
 * THE SUITE POINTS THE APP AT A TEMPORARY OBJECT ROOT, not the developer's
 * real `storage/local-objects`, so it neither depends on an ingest having been
 * run nor can write anywhere near real artwork. It does that by overriding
 * `ConfigService.get('storage')` — the same `.overrideProvider` mechanism this
 * repo's e2e suites already use for `StorageService`.
 */
describe('Local series cover artwork (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let localRoot: string;
  let previousEnv: { driver?: string; localRoot?: string };

  const idPrefix = fixtureMarker('series-cover-local-e2e-spec');

  /** A minimal but genuinely valid WebP header, plus recognisable payload. */
  const WEBP_BYTES = Buffer.concat([
    Buffer.from('RIFF', 'latin1'),
    Buffer.from([0x1a, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'latin1'),
    Buffer.from('VP8 red-panda-e2e-cover-payload', 'latin1'),
  ]);

  const PNG_BYTES = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('png-e2e-cover-payload', 'latin1'),
  ]);

  async function writeObject(key: string, bytes: Buffer): Promise<void> {
    const destination = join(localRoot, key);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }

  /** A published series with an ingested cover object on disk. */
  async function createCoveredSeries(
    suffix: string,
    bytes: Buffer,
  ): Promise<{ id: string; key: string }> {
    const id = `${idPrefix}-${suffix}`;
    const key = buildSeriesCoverObjectKey(id);

    await prisma.series.create({
      data: { id, title: `Fixture ${id}`, coverImageKey: key, sortOrder: 0 },
    });
    await writeObject(key, bytes);

    return { id, key };
  }

  beforeAll(async () => {
    localRoot = await mkdtemp(join(tmpdir(), 'red-panda-cover-e2e-'));

    // Point the app at a TEMPORARY object root, and pin the driver, BEFORE
    // `AppModule` compiles — `configuration.ts` is a factory that reads
    // `process.env` at module-init time, so this is the supported seam and
    // needs no `ConfigService` stub that every other consumer would then have
    // to be taught about. Both variables are restored in `afterAll`.
    //
    // The point of the temp root is isolation in both directions: this suite
    // neither depends on `npm run covers:ingest` having been run, nor can it
    // write anywhere near the developer's real artwork.
    previousEnv = {
      driver: process.env.STORAGE_DRIVER,
      localRoot: process.env.LOCAL_OBJECT_STORAGE_ROOT,
    };
    process.env.STORAGE_DRIVER = 'local';
    process.env.LOCAL_OBJECT_STORAGE_ROOT = localRoot;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(StorageService)
      .useValue({ createPresignedGetUrl: createPresignedGetUrlMock() })
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
  });

  afterAll(async () => {
    await prisma.series.deleteMany({ where: { id: { startsWith: idPrefix } } });
    await app.close();
    await rm(localRoot, { recursive: true, force: true });

    restoreEnv('STORAGE_DRIVER', previousEnv.driver);
    restoreEnv('LOCAL_OBJECT_STORAGE_ROOT', previousEnv.localRoot);
  });

  describe('serving a real cover', () => {
    it('returns the exact ingested bytes, typed from their own magic bytes', async () => {
      const { id } = await createCoveredSeries('webp', WEBP_BYTES);

      const response = await request(app.getHttpServer())
        .get(`/series/${id}/cover`)
        .expect(HttpStatus.OK);

      expect(response.headers['content-type']).toBe('image/webp');
      expect(response.headers['content-length']).toBe(
        String(WEBP_BYTES.length),
      );
      // The bytes themselves, not merely a 200 — a truncated or substituted
      // body would pass every header assertion above and still be a broken
      // image on screen.
      expect(Buffer.from(response.body as Buffer).equals(WEBP_BYTES)).toBe(
        true,
      );
    });

    it('types a PNG cover as image/png, from the same sniff', async () => {
      const { id } = await createCoveredSeries('png', PNG_BYTES);

      const response = await request(app.getHttpServer())
        .get(`/series/${id}/cover`)
        .expect(HttpStatus.OK);

      expect(response.headers['content-type']).toBe('image/png');
    });

    it('is fetchable with no credential at all', async () => {
      const { id } = await createCoveredSeries('anonymous', WEBP_BYTES);

      // No Authorization header — exactly how an <img>/expo-image request
      // arrives, since a no-cors image load cannot carry one.
      await request(app.getHttpServer())
        .get(`/series/${id}/cover`)
        .expect(HttpStatus.OK);
    });

    it('advertises the coverUrl that this route actually answers', async () => {
      const { id } = await createCoveredSeries('round-trip', WEBP_BYTES);
      await prisma.video.create({
        data: {
          id: `${id}-ep1`,
          seriesId: id,
          title: 'Fixture episode',
          episodeNumber: 1,
          channelName: 'E2E Channel',
          caption: 'E2E fixture caption',
          category: 'drama',
          storageKey: '',
          sourceLanguage: 'zh',
          hasEmbeddedIndonesianSubtitle: true,
          likeCount: 1,
          lifecycleState: 'published',
          contentKind: 'drama',
        },
      });

      const detail = await request(app.getHttpServer())
        .get(`/series/${id}`)
        .expect(HttpStatus.OK);

      // Closes the loop the app itself walks: whatever GET /series/:id says
      // the artwork URL is, fetching that exact URL must return the artwork.
      const { coverUrl } = detail.body as SeriesDetailPublicDto;
      expect(coverUrl).not.toBeNull();

      const path = new URL(coverUrl!).pathname;
      const fetched = await request(app.getHttpServer())
        .get(path)
        .expect(HttpStatus.OK);

      expect(Buffer.from(fetched.body as Buffer).equals(WEBP_BYTES)).toBe(true);

      await prisma.video.deleteMany({ where: { seriesId: id } });
    });
  });

  describe('cross-origin behaviour', () => {
    it('marks the artwork cross-origin readable, so a browser does not discard it', async () => {
      const { id } = await createCoveredSeries('corp', WEBP_BYTES);

      const response = await request(app.getHttpServer())
        .get(`/series/${id}/cover`)
        .expect(HttpStatus.OK);

      expect(response.headers['cross-origin-resource-policy']).toBe(
        'cross-origin',
      );
    });

    /**
     * The SCOPE check: relaxing CORP for artwork must not relax it for the
     * JSON API.
     *
     * Asserted as "not cross-origin" rather than "exactly same-origin"
     * because `helmet()` is applied in `main.ts`'s `bootstrap()`, which an
     * e2e app built with `createNestApplication()` never runs — so no route
     * carries helmet's default header in THIS harness, and asserting the
     * literal `same-origin` here would be asserting helmet's behaviour rather
     * than this route's. What is genuinely this work unit's to get wrong is
     * the override leaking off the handler and onto the app, and that is
     * exactly what this catches.
     */
    it('does not relax cross-origin policy for any other route', async () => {
      const response = await request(app.getHttpServer())
        .get('/series')
        .expect(HttpStatus.OK);

      expect(response.headers['cross-origin-resource-policy']).not.toBe(
        'cross-origin',
      );
    });
  });

  describe('truthful 404s', () => {
    it('404s for a series that does not exist', async () => {
      await request(app.getHttpServer())
        .get(`/series/${idPrefix}-absent/cover`)
        .expect(HttpStatus.NOT_FOUND);
    });

    it('404s for a series with no coverImageKey', async () => {
      const id = `${idPrefix}-no-cover`;
      await prisma.series.create({
        data: { id, title: `Fixture ${id}`, coverImageKey: null, sortOrder: 0 },
      });

      await request(app.getHttpServer())
        .get(`/series/${id}/cover`)
        .expect(HttpStatus.NOT_FOUND);
    });

    it('404s when the row names an object that is not on disk', async () => {
      const id = `${idPrefix}-missing-object`;
      await prisma.series.create({
        data: {
          id,
          title: `Fixture ${id}`,
          coverImageKey: buildSeriesCoverObjectKey(id),
          sortOrder: 0,
        },
      });

      // No writeObject call: the pointer exists, the bytes do not.
      await request(app.getHttpServer())
        .get(`/series/${id}/cover`)
        .expect(HttpStatus.NOT_FOUND);
    });

    it('404s for an archived series, whose metadata is already hidden', async () => {
      const { id } = await createCoveredSeries('archived', WEBP_BYTES);
      await prisma.series.update({
        where: { id },
        data: { archivedAt: new Date() },
      });

      await request(app.getHttpServer())
        .get(`/series/${id}/cover`)
        .expect(HttpStatus.NOT_FOUND);
    });

    it('refuses to serve a file whose bytes are not a permitted image format', async () => {
      const id = `${idPrefix}-svg`;
      const key = buildSeriesCoverObjectKey(id);
      await prisma.series.create({
        data: { id, title: `Fixture ${id}`, coverImageKey: key, sortOrder: 0 },
      });
      // An SVG is deliberately excluded from the cover allow-list: it is a
      // script-execution surface. Naming it under a valid cover key must not
      // be enough to get it served.
      await writeObject(
        key,
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      );

      await request(app.getHttpServer())
        .get(`/series/${id}/cover`)
        .expect(HttpStatus.NOT_FOUND);
    });

    it('refuses a coverImageKey this series’ own upload flow could not have minted', async () => {
      const id = `${idPrefix}-foreign-key`;
      // A well-formed key belonging to a DIFFERENT series. The bytes are
      // written, so only the ownership check can produce the 404.
      const foreignKey = buildSeriesCoverObjectKey(`${idPrefix}-other`);
      await prisma.series.create({
        data: {
          id,
          title: `Fixture ${id}`,
          coverImageKey: foreignKey,
          sortOrder: 0,
        },
      });
      await writeObject(foreignKey, WEBP_BYTES);

      await request(app.getHttpServer())
        .get(`/series/${id}/cover`)
        .expect(HttpStatus.NOT_FOUND);
    });
  });

  describe('path traversal', () => {
    /**
     * A file that exists, is a valid image, and sits OUTSIDE the object root.
     * If any of these requests returned 200 it would be a real escape, not a
     * theoretical one.
     */
    let outsidePath: string;

    beforeAll(async () => {
      outsidePath = join(dirname(localRoot), 'outside-the-root.webp');
      await writeFile(outsidePath, WEBP_BYTES);
    });

    afterAll(async () => {
      await rm(outsidePath, { force: true });
    });

    it.each([
      ['a parent traversal', '../../../../etc/passwd'],
      ['an encoded traversal', '..%2F..%2F..%2Fetc%2Fpasswd'],
      ['a double-encoded traversal', '%2e%2e%2f%2e%2e%2fetc%2fpasswd'],
      [
        'a traversal smuggled after a real series id',
        'x%2F..%2F..%2Foutside-the-root.webp',
      ],
      ['an absolute path', '%2Fetc%2Fpasswd'],
    ])('never serves anything for %s', async (_label, id) => {
      const response = await request(app.getHttpServer()).get(
        `/series/${id}/cover`,
      );

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('cannot be reached even when the row itself carries an escaping key', async () => {
      const id = `${idPrefix}-escaping-key`;
      await prisma.series.create({
        data: {
          id,
          title: `Fixture ${id}`,
          // Not a shape `buildSeriesCoverObjectKey` can produce — this is the
          // guard holding for a value that only a direct database write, or a
          // future loosening of the key contract, could put here.
          coverImageKey: '../outside-the-root.webp',
          sortOrder: 0,
        },
      });

      await request(app.getHttpServer())
        .get(`/series/${id}/cover`)
        .expect(HttpStatus.NOT_FOUND);
    });
  });
});

/**
 * Restores an env var to exactly what it was, INCLUDING having been unset —
 * assigning `undefined` to `process.env.X` stores the string `"undefined"`,
 * which would leave a bogus path behind for whatever suite this worker runs
 * next.
 */
function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = previous;
}
