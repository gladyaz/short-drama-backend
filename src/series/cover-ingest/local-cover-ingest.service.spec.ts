import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import {
  buildTestStorageConfig,
  createConfigServiceMock,
} from '../../common/testing/config-mock.helpers';
import { fixtureMarker } from '../../common/testing/fixture-namespace.helpers';
import { PrismaService } from '../../prisma/prisma.service';
import { isValidSeriesCoverObjectKey } from '../series-cover-key.util';
import { LocalCoverIngestService } from './local-cover-ingest.service';

/**
 * Work unit "LOCAL SERIES COVER ARTWORK": the ingest is the only thing in this
 * slice that WRITES — to the filesystem and to `Series`. These tests pin what
 * it writes, what it refuses to write, and that a dry run writes nothing.
 *
 * `PrismaService` is the real client against the project's Postgres test
 * database, following the `SeriesService`/`AdminMediaService` integration-style
 * precedent, self-cleaning via `afterEach`. Fixture ids are namespaced from the
 * shared per-run `TEST_FIXTURE_NAMESPACE` so a parallel worker in another
 * worktree cannot collide.
 */
describe('LocalCoverIngestService', () => {
  let service: LocalCoverIngestService;
  let prisma: PrismaService;
  let sourceDir: string;
  let localRoot: string;

  const idPrefix = fixtureMarker('local-cover-ingest-spec');

  const WEBP_BYTES = Buffer.concat([
    Buffer.from('RIFF', 'latin1'),
    Buffer.from([0x1a, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'latin1'),
    Buffer.from('VP8 ingest-spec-payload', 'latin1'),
  ]);

  async function buildService(driver: 'local' | 'r2'): Promise<void> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocalCoverIngestService,
        PrismaService,
        {
          provide: ConfigService,
          useValue: createConfigServiceMock({
            storage: buildTestStorageConfig({ driver, localRoot }),
          }),
        },
      ],
    }).compile();

    service = module.get(LocalCoverIngestService);
    prisma = module.get(PrismaService);
    await prisma.onModuleInit();
  }

  async function createSeries(suffix: string): Promise<string> {
    const id = `${idPrefix}-${suffix}`;
    await prisma.series.create({
      data: { id, title: `Fixture ${id}`, coverImageKey: null, sortOrder: 0 },
    });
    return id;
  }

  /** An asset named for `seriesId`, which is the whole join key. */
  async function writeAsset(seriesId: string, bytes: Buffer): Promise<void> {
    await writeFile(join(sourceDir, `${seriesId}.webp`), bytes);
  }

  beforeEach(async () => {
    sourceDir = await mkdtemp(join(tmpdir(), 'red-panda-ingest-src-'));
    localRoot = await mkdtemp(join(tmpdir(), 'red-panda-ingest-root-'));
    await buildService('local');
  });

  afterEach(async () => {
    await prisma.series.deleteMany({ where: { id: { startsWith: idPrefix } } });
    await rm(sourceDir, { recursive: true, force: true });
    await rm(localRoot, { recursive: true, force: true });
  });

  describe('apply', () => {
    it('copies the asset to a versioned key and points the row at it', async () => {
      const id = await createSeries('happy');
      await writeAsset(id, WEBP_BYTES);

      const report = await service.run({ sourceDir, apply: true });
      const outcome = report.outcomes.find((o) => o.seriesId === id);

      expect(outcome?.status).toBe('ingested');

      const persisted = await prisma.series.findUnique({ where: { id } });
      expect(persisted?.coverImageKey).not.toBeNull();
      // The SAME key layout r2 mints, so this row is migratable without
      // re-keying — and the same shape the public cover route will accept.
      expect(isValidSeriesCoverObjectKey(id, persisted!.coverImageKey!)).toBe(
        true,
      );

      const written = await readFile(
        join(localRoot, persisted!.coverImageKey!),
      );
      expect(written.equals(WEBP_BYTES)).toBe(true);
    });

    it('never invents a cover for a series with no matching asset', async () => {
      const id = await createSeries('no-asset');

      const report = await service.run({ sourceDir, apply: true });
      const outcome = report.outcomes.find((o) => o.seriesId === id);

      expect(outcome?.status).toBe('skipped');
      const persisted = await prisma.series.findUnique({ where: { id } });
      expect(persisted?.coverImageKey).toBeNull();
    });

    it('mints a fresh key per run, so a replacement never overwrites live bytes', async () => {
      const id = await createSeries('replace');
      await writeAsset(id, WEBP_BYTES);

      await service.run({ sourceDir, apply: true });
      const first = (await prisma.series.findUnique({ where: { id } }))!
        .coverImageKey;

      await service.run({ sourceDir, apply: true });
      const second = (await prisma.series.findUnique({ where: { id } }))!
        .coverImageKey;

      expect(second).not.toBe(first);
      // The superseded object is deliberately left on disk rather than
      // deleted: a client may still be mid-download of it. Reclaiming it is
      // the existing cover-orphan sweep's job.
      await expect(readFile(join(localRoot, first!))).resolves.toBeDefined();
    });

    it('reports a replacement as a replacement', async () => {
      const id = await createSeries('replace-report');
      await writeAsset(id, WEBP_BYTES);
      await service.run({ sourceDir, apply: true });
      const first = (await prisma.series.findUnique({ where: { id } }))!
        .coverImageKey;

      const report = await service.run({ sourceDir, apply: true });
      const outcome = report.outcomes.find((o) => o.seriesId === id);

      expect(
        outcome?.status === 'ingested' ? outcome.previousCoverImageKey : null,
      ).toBe(first);
    });

    it('leaves a series untouched when its asset is not a permitted format', async () => {
      const id = await createSeries('svg');
      // Excluded from the cover allow-list outright: a script-execution
      // surface. Naming it correctly must not be enough.
      await writeAsset(
        id,
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      );

      const report = await service.run({ sourceDir, apply: true });
      const outcome = report.outcomes.find((o) => o.seriesId === id);

      expect(outcome?.status).toBe('failed');
      const persisted = await prisma.series.findUnique({ where: { id } });
      expect(persisted?.coverImageKey).toBeNull();
    });

    it('leaves a series untouched when its asset is empty', async () => {
      const id = await createSeries('empty');
      await writeAsset(id, Buffer.alloc(0));

      const report = await service.run({ sourceDir, apply: true });

      expect(report.outcomes.find((o) => o.seriesId === id)?.status).toBe(
        'failed',
      );
      expect(
        (await prisma.series.findUnique({ where: { id } }))?.coverImageKey,
      ).toBeNull();
    });

    /**
     * One bad asset must not abandon the rest of the catalog half-covered.
     */
    it('ingests the good assets even when another one fails', async () => {
      const good = await createSeries('mixed-good');
      const bad = await createSeries('mixed-bad');
      await writeAsset(good, WEBP_BYTES);
      await writeAsset(bad, Buffer.from('not an image'));

      const report = await service.run({ sourceDir, apply: true });

      expect(report.outcomes.find((o) => o.seriesId === good)?.status).toBe(
        'ingested',
      );
      expect(report.outcomes.find((o) => o.seriesId === bad)?.status).toBe(
        'failed',
      );
    });

    it('ignores a nested directory rather than recursing into it', async () => {
      const id = await createSeries('nested');
      await mkdir(join(sourceDir, `${id}.webp`), { recursive: true });

      const report = await service.run({ sourceDir, apply: true });

      expect(report.outcomes.find((o) => o.seriesId === id)?.status).toBe(
        'skipped',
      );
    });
  });

  describe('dry run', () => {
    it('reports what it would do and writes nothing at all', async () => {
      const id = await createSeries('dry');
      await writeAsset(id, WEBP_BYTES);

      const report = await service.run({ sourceDir, apply: false });
      const outcome = report.outcomes.find((o) => o.seriesId === id);

      expect(outcome?.status).toBe('would-ingest');
      expect(report.applied).toBe(false);

      const persisted = await prisma.series.findUnique({ where: { id } });
      expect(persisted?.coverImageKey).toBeNull();

      const planned =
        outcome?.status === 'would-ingest' ? outcome.key : 'unreachable';
      await expect(readFile(join(localRoot, planned))).rejects.toThrow();
    });
  });

  describe('driver guard', () => {
    /**
     * The one refusal that protects PRODUCTION rather than local tidiness:
     * under r2 the authoritative artwork is in the bucket, and writing local
     * keys over those rows would repoint live covers at files that exist on a
     * single machine.
     */
    it('refuses to run at all under the r2 driver, before touching anything', async () => {
      await buildService('r2');
      const id = await createSeries('r2-guard');
      await writeAsset(id, WEBP_BYTES);

      await expect(service.run({ sourceDir, apply: true })).rejects.toThrow(
        /STORAGE_DRIVER/,
      );

      expect(
        (await prisma.series.findUnique({ where: { id } }))?.coverImageKey,
      ).toBeNull();
    });

    it('refuses a dry run under r2 too, so the refusal is not apply-only', async () => {
      await buildService('r2');

      await expect(service.run({ sourceDir, apply: false })).rejects.toThrow(
        /not "local"/,
      );
    });
  });
});
