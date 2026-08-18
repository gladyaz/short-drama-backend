import { randomUUID } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FakeObjectStorage,
  asStorageService,
} from '../../common/testing/fake-object-storage.helpers';
import { fixtureMarker } from '../../common/testing/fixture-namespace.helpers';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { buildSeriesCoverObjectKey } from '../series-cover-key.util';
import { SERIES_COVER_ORPHAN_APPLY_BUCKET_ENV } from './series-cover-orphan-env-guard';
import {
  SERIES_COVER_ORPHAN_GRACE_MS,
  SERIES_COVER_ORPHAN_MAX_PAGES,
  SERIES_COVER_ORPHAN_MAX_REPORTED_CANDIDATES,
} from './series-cover-orphan.constants';
import { SeriesCoverOrphanService } from './series-cover-orphan.service';
import { SeriesCoverOrphanReport } from './series-cover-orphan.types';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Slice "SERIES COVER ORPHAN CLEANUP LIFECYCLE".
 *
 * `PrismaService` is the REAL client against this project's Postgres test
 * database, following the `SeriesService`/`AdminMediaService`
 * integration-style precedent, self-cleaning via `afterEach` and namespaced
 * per process (`fixtureMarker`) because every worktree of this repository
 * points at the same database.
 *
 * Storage is a `FakeObjectStorage` — an in-memory `Map`. NO test in this
 * file constructs an `S3Client`, reads a credential, or issues a network
 * call, and the sweep never sees any object except the ones a test put
 * there.
 *
 * ## Why the sweep clock is pinned far in the future
 *
 * `Series.updatedAt` is Prisma's `@updatedAt` and lands at real "now" when a
 * fixture row is created, which no test can control. Rather than fighting
 * that, every sweep is run with an explicit `now` well past the fixtures'
 * creation instant, so the derived cutoff is deterministic relative to both
 * the object timestamps (which the fake DOES control) and the rows'
 * `updatedAt`. `SWEEP_NOW` sits 10 days ahead, so fixture rows are
 * comfortably "quiet"; `SWEEP_NOW_SOON` sits 12 hours ahead, so they are
 * comfortably "recently modified". No sleeps, no timer mocking, no flake.
 */
describe('SeriesCoverOrphanService', () => {
  let service: SeriesCoverOrphanService;
  let prisma: PrismaService;
  let storage: FakeObjectStorage;

  const testIdPrefix = fixtureMarker('cover-orphan-spec');

  /** Real instant the suite started; every fixture row's `updatedAt` is ~this. */
  const REAL_NOW = new Date();
  /** Sweep clock: far enough ahead that fixture rows are NOT "recently modified". */
  const SWEEP_NOW = new Date(REAL_NOW.getTime() + 10 * DAY_MS);
  /** Sweep clock: near enough that fixture rows ARE "recently modified". */
  const SWEEP_NOW_SOON = new Date(REAL_NOW.getTime() + 12 * HOUR_MS);
  /** Objects older than this are age-eligible for a `SWEEP_NOW` sweep. */
  const CUTOFF = new Date(SWEEP_NOW.getTime() - SERIES_COVER_ORPHAN_GRACE_MS);
  /** Comfortably older than `CUTOFF`. */
  const OLD = new Date(REAL_NOW.getTime() - DAY_MS);
  /** Comfortably newer than `CUTOFF`. */
  const RECENT = new Date(SWEEP_NOW.getTime() - HOUR_MS);

  beforeEach(async () => {
    storage = new FakeObjectStorage();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SeriesCoverOrphanService,
        PrismaService,
        { provide: StorageService, useValue: asStorageService(storage) },
      ],
    }).compile();

    service = module.get(SeriesCoverOrphanService);
    prisma = module.get(PrismaService);
    await prisma.onModuleInit();
  });

  afterEach(async () => {
    await prisma.series.deleteMany({
      where: { id: { startsWith: testIdPrefix } },
    });
    await prisma.onModuleDestroy();
  });

  /** A namespaced series id, unique per call. */
  function seriesId(label: string): string {
    return `${testIdPrefix}-${label}-${randomUUID().slice(0, 8)}`;
  }

  async function createSeries(
    id: string,
    cover: {
      coverImageKey?: string | null;
      pendingCoverImageKey?: string | null;
    } = {},
  ): Promise<void> {
    await prisma.series.create({
      data: {
        id,
        title: `Fixture ${id}`,
        coverImageKey: cover.coverImageKey ?? null,
        pendingCoverImageKey: cover.pendingCoverImageKey ?? null,
      },
    });
  }

  /**
   * Runs the body with the two `--apply` gate variables satisfied, then
   * restores them. The bucket name is deliberately synthetic — the sweep's
   * storage is a `Map`, so the value never reaches anything real; it exists
   * only so the identity gate can be exercised at all.
   */
  async function withApplyEnv<T>(body: () => Promise<T>): Promise<T> {
    const originalBucket = process.env.OBJECT_STORAGE_BUCKET;
    const originalConfirmation =
      process.env[SERIES_COVER_ORPHAN_APPLY_BUCKET_ENV];

    process.env.OBJECT_STORAGE_BUCKET = 'fake-bucket.invalid';
    process.env[SERIES_COVER_ORPHAN_APPLY_BUCKET_ENV] = 'fake-bucket.invalid';

    try {
      return await body();
    } finally {
      restoreEnv('OBJECT_STORAGE_BUCKET', originalBucket);
      restoreEnv(SERIES_COVER_ORPHAN_APPLY_BUCKET_ENV, originalConfirmation);
    }
  }

  /** Every scanned object lands in exactly one bucket — see `SeriesCoverOrphanReport`. */
  function expectCountersToSum(report: SeriesCoverOrphanReport): void {
    expect(
      report.ignoredForeignKey +
        report.protected +
        report.unknownAge +
        report.tooRecent +
        report.seriesRecentlyModified +
        report.eligible,
    ).toBe(report.scanned);

    if (report.apply) {
      expect(report.deleted + report.failed + report.skippedOnRecheck).toBe(
        report.eligible,
      );
    } else {
      expect(report.deleted).toBe(0);
    }
  }

  function candidateKeys(report: SeriesCoverOrphanReport): string[] {
    return report.candidates.map((candidate) => candidate.key).sort();
  }

  describe('the primary safety invariant: a referenced key is never a candidate', () => {
    it('never proposes the CURRENT cover, however old the object is', async () => {
      const id = seriesId('live-cover');
      const liveKey = buildSeriesCoverObjectKey(id);
      await createSeries(id, { coverImageKey: liveKey });
      // Deliberately ancient — age must not be able to override protection.
      storage.put(liveKey, new Date(0));

      const report = await service.buildReport(SWEEP_NOW);

      expect(report.protected).toBe(1);
      expect(report.eligible).toBe(0);
      expect(candidateKeys(report)).toEqual([]);
      expectCountersToSum(report);
    });

    it('never proposes the CURRENT PENDING upload intent, however old the object is', async () => {
      const id = seriesId('pending-cover');
      const pendingKey = buildSeriesCoverObjectKey(id);
      await createSeries(id, { pendingCoverImageKey: pendingKey });
      storage.put(pendingKey, new Date(0));

      const report = await service.buildReport(SWEEP_NOW);

      // Object cleanup and pending-INTENT expiry are separate policies. This
      // sweep never decides an intent is stale; while the column points at
      // the key, the object is protected — even if that means an abandoned
      // pending upload is retained indefinitely.
      expect(report.protected).toBe(1);
      expect(report.eligible).toBe(0);
      expectCountersToSum(report);
    });

    it('protects a key referenced by a DIFFERENT series than the one its prefix names', async () => {
      // `UpdateSeriesDto.coverImageKey`/`CreateSeriesDto.coverImageKey` are
      // `@IsString() @Length(1, 500)` with no shape check, so an admin can
      // point series B at a key minted under series A's prefix. A reference
      // lookup scoped to the key's OWN parsed seriesId would miss this.
      const ownerId = seriesId('cross-owner');
      const borrowerId = seriesId('cross-borrower');
      const key = buildSeriesCoverObjectKey(ownerId);

      await createSeries(ownerId);
      await createSeries(borrowerId, { coverImageKey: key });
      storage.put(key, OLD);

      const report = await service.buildReport(SWEEP_NOW);

      expect(report.protected).toBe(1);
      expect(report.eligible).toBe(0);
    });

    it('protects an object whose series row no longer exists but whose key another row adopted', async () => {
      // `Series.id` is client-provided and `remove` is a hard delete, so a
      // deleted id can be recreated later pointing at an old key.
      const deletedId = seriesId('recreated');
      const key = buildSeriesCoverObjectKey(deletedId);
      storage.put(key, OLD);

      await createSeries(deletedId, { coverImageKey: key });

      const report = await service.buildReport(SWEEP_NOW);

      expect(report.protected).toBe(1);
      expect(report.eligible).toBe(0);
    });
  });

  describe('grace period', () => {
    it('protects a RECENT unreferenced object', async () => {
      const id = seriesId('recent-unreferenced');
      const key = buildSeriesCoverObjectKey(id);
      await createSeries(id);
      storage.put(key, RECENT);

      const report = await service.buildReport(SWEEP_NOW);

      expect(report.tooRecent).toBe(1);
      expect(report.eligible).toBe(0);
      expectCountersToSum(report);
    });

    it('proposes an OLD unreferenced object', async () => {
      const id = seriesId('old-unreferenced');
      const key = buildSeriesCoverObjectKey(id);
      await createSeries(id);
      storage.put(key, OLD);

      const report = await service.buildReport(SWEEP_NOW);

      expect(report.eligible).toBe(1);
      expect(candidateKeys(report)).toEqual([key]);
      expect(report.candidates[0]).toMatchObject({
        seriesId: id,
        reason: 'unreferenced-and-past-grace',
        outcome: 'dry-run',
      });
      expectCountersToSum(report);
    });

    it('treats an object EXACTLY at the cutoff as still within grace', async () => {
      // Eligibility is strictly `lastModified < cutoff`, never `<=`.
      const id = seriesId('boundary');
      const key = buildSeriesCoverObjectKey(id);
      await createSeries(id);
      storage.put(key, CUTOFF);

      const report = await service.buildReport(SWEEP_NOW);

      expect(report.tooRecent).toBe(1);
      expect(report.eligible).toBe(0);
    });

    it('proposes an object one millisecond older than the cutoff', async () => {
      const id = seriesId('boundary-minus');
      const key = buildSeriesCoverObjectKey(id);
      await createSeries(id);
      storage.put(key, new Date(CUTOFF.getTime() - 1));

      const report = await service.buildReport(SWEEP_NOW);

      expect(report.eligible).toBe(1);
    });

    it('protects an object whose listing carried NO timestamp at all', async () => {
      const id = seriesId('no-timestamp');
      const key = buildSeriesCoverObjectKey(id);
      await createSeries(id);
      storage.put(key, undefined);

      const report = await service.buildReport(SWEEP_NOW);

      // Age unprovable ⇒ never removed. Reported under its own counter so
      // the reason is visible rather than hidden inside `tooRecent`.
      expect(report.unknownAge).toBe(1);
      expect(report.eligible).toBe(0);
      expectCountersToSum(report);
    });

    it('protects the whole cover namespace of a series modified inside the grace window', async () => {
      const id = seriesId('recently-edited');
      const key = buildSeriesCoverObjectKey(id);
      await createSeries(id);
      storage.put(key, OLD);

      const report = await service.buildReport(SWEEP_NOW_SOON);

      expect(report.seriesRecentlyModified).toBe(1);
      expect(report.eligible).toBe(0);
      expectCountersToSum(report);
    });
  });

  describe('namespace isolation', () => {
    it('ignores every object outside the Series-cover prefix', async () => {
      const id = seriesId('namespace');
      const coverKey = buildSeriesCoverObjectKey(id);
      await createSeries(id);

      storage.put(coverKey, OLD);
      storage.put('admin-media/video-1/source', OLD);
      storage.put('admin-media/video-1/cover', OLD);
      storage.put('admin-media/video-1/hls/v1-a1-uuid/master.m3u8', OLD);
      storage.put('admin-media/video-1/hls/v1-a1-uuid/360p/000.ts', OLD);
      storage.put('admin-media/video-1/thumbnail', OLD);
      storage.put('_r2-smoke-tests/scratch.txt', OLD);
      storage.put('some-root-object.bin', OLD);

      const report = await service.buildReport(SWEEP_NOW);

      // Only the ONE Series-cover key was even enumerated: everything else
      // lives outside the listed prefix and never reaches classification.
      expect(report.scanned).toBe(1);
      expect(report.eligible).toBe(1);
      expect(candidateKeys(report)).toEqual([coverKey]);
      expect(storage.listCalls[0].prefix).toBe('admin-series/');
    });

    it('counts a malformed key under the root prefix as foreign and never proposes it', async () => {
      const id = seriesId('malformed');
      await createSeries(id);

      storage.put('admin-series/whatever/cover/not-a-uuid', OLD);
      storage.put(`admin-series/whatever/cover/${randomUUID()}/extra`, OLD);
      storage.put('admin-series/whatever/poster/uuid', OLD);

      const report = await service.buildReport(SWEEP_NOW);

      expect(report.scanned).toBe(3);
      expect(report.ignoredForeignKey).toBe(3);
      expect(report.eligible).toBe(0);
      expectCountersToSum(report);
    });
  });

  describe('the four known orphan sources', () => {
    it('A: an abandoned upload (presigned, uploaded, never completed) becomes eligible after grace', async () => {
      // `createCoverUpload` set `pendingCoverImageKey`, the browser PUT the
      // bytes, the admin closed the tab — and a LATER explicit clear (or a
      // newer intent) left the column no longer pointing at this key.
      const id = seriesId('abandoned');
      const abandonedKey = buildSeriesCoverObjectKey(id);
      await createSeries(id, { pendingCoverImageKey: null });
      storage.put(abandonedKey, OLD);

      const report = await service.buildReport(SWEEP_NOW);

      expect(candidateKeys(report)).toEqual([abandonedKey]);
    });

    it('B: a SUPERSEDED intent object is retained before grace and eligible after it', async () => {
      // Intent A uploaded, then intent B overwrote `pendingCoverImageKey`.
      // A can never complete (the compare-and-set rejects it), so its object
      // is stranded — but not touched until it is genuinely old.
      const id = seriesId('superseded');
      const supersededKeyA = buildSeriesCoverObjectKey(id);
      const currentKeyB = buildSeriesCoverObjectKey(id);
      await createSeries(id, { pendingCoverImageKey: currentKeyB });

      storage.put(supersededKeyA, RECENT);
      storage.put(currentKeyB, RECENT);

      const beforeGrace = await service.buildReport(SWEEP_NOW);

      expect(beforeGrace.protected).toBe(1); // B, the live intent
      expect(beforeGrace.tooRecent).toBe(1); // A, stranded but still young
      expect(beforeGrace.eligible).toBe(0);

      // Same DB state, same objects — only A has now aged past the window.
      storage.put(supersededKeyA, OLD);
      const afterGrace = await service.buildReport(SWEEP_NOW);

      expect(candidateKeys(afterGrace)).toEqual([supersededKeyA]);
      expect(afterGrace.protected).toBe(1); // B still protected
    });

    it('C: an object left by a failed completion becomes eligible after grace', async () => {
      // Upload landed but `complete` rejected it (content type / size), so
      // the row promoted nothing and cleared nothing.
      const id = seriesId('failed-completion');
      const rejectedKey = buildSeriesCoverObjectKey(id);
      await createSeries(id, { pendingCoverImageKey: null });
      storage.put(rejectedKey, OLD);

      const report = await service.buildReport(SWEEP_NOW);

      expect(candidateKeys(report)).toEqual([rejectedKey]);
    });

    it('D: after a successful replacement the OLD cover is eligible and the NEW one is protected', async () => {
      const id = seriesId('replaced');
      const previousKey = buildSeriesCoverObjectKey(id);
      const currentKey = buildSeriesCoverObjectKey(id);
      await createSeries(id, { coverImageKey: currentKey });

      storage.put(previousKey, RECENT);
      storage.put(currentKey, RECENT);

      const beforeGrace = await service.buildReport(SWEEP_NOW);

      expect(beforeGrace.protected).toBe(1);
      expect(beforeGrace.tooRecent).toBe(1);
      expect(beforeGrace.eligible).toBe(0);

      storage.put(previousKey, OLD);
      const afterGrace = await service.buildReport(SWEEP_NOW);

      expect(candidateKeys(afterGrace)).toEqual([previousKey]);
      expect(afterGrace.protected).toBe(1);
      // The live cover is never even a candidate, so it can never be removed.
      expect(candidateKeys(afterGrace)).not.toContain(currentKey);
    });

    it('E: a HARD-DELETED series leaves its old cover eligible after grace', async () => {
      // `SeriesService.remove` deletes the row and never touches storage, so
      // there is no row left for a row-driven sweep to iterate from — this
      // is exactly why enumeration is storage-driven.
      const id = seriesId('deleted-series');
      const orphanKey = buildSeriesCoverObjectKey(id);
      await createSeries(id, { coverImageKey: orphanKey });
      storage.put(orphanKey, OLD);

      const whileRowExists = await service.buildReport(SWEEP_NOW);
      expect(whileRowExists.protected).toBe(1);
      expect(whileRowExists.eligible).toBe(0);

      await prisma.series.delete({ where: { id } });

      const afterRowDeleted = await service.buildReport(SWEEP_NOW);
      expect(candidateKeys(afterRowDeleted)).toEqual([orphanKey]);
    });
  });

  describe('dry run', () => {
    it('removes ZERO objects and reports deleted = 0', async () => {
      const id = seriesId('dry-run');
      const keys = [
        buildSeriesCoverObjectKey(id),
        buildSeriesCoverObjectKey(id),
        buildSeriesCoverObjectKey(id),
      ];
      await createSeries(id);
      for (const key of keys) {
        storage.put(key, OLD);
      }

      const report = await service.buildReport(SWEEP_NOW);

      expect(report.apply).toBe(false);
      expect(report.eligible).toBe(3);
      expect(report.deleted).toBe(0);
      // The strongest form of the assertion: `deleteObject` was never even
      // CALLED, not merely "called and no-oped".
      expect(storage.deleteAttempts).toEqual([]);
      expect(storage.size).toBe(3);
      expect(storage.keys()).toEqual([...keys].sort());
    });

    it('is the default for run() with no options at all', async () => {
      const id = seriesId('default-mode');
      const key = buildSeriesCoverObjectKey(id);
      await createSeries(id);
      storage.put(key, OLD);

      const report = await service.run();

      expect(report.apply).toBe(false);
      expect(storage.deleteAttempts).toEqual([]);
    });

    it.each([
      ['undefined', undefined],
      ['the string "true"', 'true'],
      ['the number 1', 1],
    ])('treats apply=%s as a dry run', async (_label, applyValue) => {
      const id = seriesId('truthy-apply');
      const key = buildSeriesCoverObjectKey(id);
      await createSeries(id);
      storage.put(key, OLD);

      const report = await service.run({
        apply: applyValue as unknown as boolean,
        now: SWEEP_NOW,
      });

      expect(report.apply).toBe(false);
      expect(storage.deleteAttempts).toEqual([]);
      expect(storage.has(key)).toBe(true);
    });
  });

  describe('apply mode', () => {
    it('refuses outright unless the bucket confirmation gate passes', async () => {
      const id = seriesId('gate-refusal');
      const key = buildSeriesCoverObjectKey(id);
      await createSeries(id);
      storage.put(key, OLD);

      // No SERIES_COVER_ORPHAN_APPLY_BUCKET is set in this checkout, so the
      // guard refuses before any listing happens at all.
      await expect(
        service.run({ apply: true, now: SWEEP_NOW }),
      ).rejects.toThrow(/Refusing to run the Series cover orphan sweep/);

      expect(storage.listCalls).toEqual([]);
      expect(storage.deleteAttempts).toEqual([]);
      expect(storage.has(key)).toBe(true);
    });

    it('removes ONLY the eligible objects, leaving protected and recent ones intact', async () => {
      const id = seriesId('selective-apply');
      const liveKey = buildSeriesCoverObjectKey(id);
      const pendingKey = buildSeriesCoverObjectKey(id);
      const recentOrphan = buildSeriesCoverObjectKey(id);
      const oldOrphanA = buildSeriesCoverObjectKey(id);
      const oldOrphanB = buildSeriesCoverObjectKey(id);
      const foreignKey = 'admin-media/video-1/source';

      await createSeries(id, {
        coverImageKey: liveKey,
        pendingCoverImageKey: pendingKey,
      });

      storage.put(liveKey, OLD);
      storage.put(pendingKey, OLD);
      storage.put(recentOrphan, RECENT);
      storage.put(oldOrphanA, OLD);
      storage.put(oldOrphanB, OLD);
      storage.put(foreignKey, OLD);

      const report = await withApplyEnv(() =>
        service.run({ apply: true, now: SWEEP_NOW }),
      );

      expect(report.apply).toBe(true);
      expect(report.protected).toBe(2);
      expect(report.tooRecent).toBe(1);
      expect(report.eligible).toBe(2);
      expect(report.deleted).toBe(2);
      expect(report.failed).toBe(0);
      expect(report.skippedOnRecheck).toBe(0);
      expectCountersToSum(report);

      expect([...storage.deletedKeys].sort()).toEqual(
        [oldOrphanA, oldOrphanB].sort(),
      );
      expect(storage.keys()).toEqual(
        [liveKey, pendingKey, recentOrphan, foreignKey].sort(),
      );
    });

    it('is idempotent: a second apply run finds nothing and removes nothing', async () => {
      const id = seriesId('idempotent');
      const liveKey = buildSeriesCoverObjectKey(id);
      const orphanKey = buildSeriesCoverObjectKey(id);
      await createSeries(id, { coverImageKey: liveKey });
      storage.put(liveKey, OLD);
      storage.put(orphanKey, OLD);

      const first = await withApplyEnv(() =>
        service.run({ apply: true, now: SWEEP_NOW }),
      );
      expect(first.deleted).toBe(1);

      const second = await withApplyEnv(() =>
        service.run({ apply: true, now: SWEEP_NOW }),
      );

      expect(second.scanned).toBe(1);
      expect(second.protected).toBe(1);
      expect(second.eligible).toBe(0);
      expect(second.deleted).toBe(0);
      expect(storage.deletedKeys).toEqual([orphanKey]);
      expect(storage.keys()).toEqual([liveKey]);
    });

    it('handles multiple candidates independently — one failure never stops the others', async () => {
      const id = seriesId('multi-candidate');
      const keys = [
        buildSeriesCoverObjectKey(id),
        buildSeriesCoverObjectKey(id),
        buildSeriesCoverObjectKey(id),
        buildSeriesCoverObjectKey(id),
      ].sort();
      await createSeries(id);
      for (const key of keys) {
        storage.put(key, OLD);
      }
      // Fail the SECOND key, so there is a candidate both before and after
      // the failure — a sweep that aborted on error would leave the last two.
      storage.failDeletesFor(keys[1]);

      const report = await withApplyEnv(() =>
        service.run({ apply: true, now: SWEEP_NOW }),
      );

      expect(report.eligible).toBe(4);
      expect(report.deleted).toBe(3);
      expect(report.failed).toBe(1);
      expectCountersToSum(report);

      expect(storage.deleteAttempts).toHaveLength(4);
      expect(storage.keys()).toEqual([keys[1]]);
      expect(
        report.candidates.filter((c) => c.outcome === 'failed'),
      ).toHaveLength(1);
    });

    it('a delete failure changes NOTHING in the database', async () => {
      const id = seriesId('failure-no-db-change');
      const liveKey = buildSeriesCoverObjectKey(id);
      const orphanKey = buildSeriesCoverObjectKey(id);
      await createSeries(id, { coverImageKey: liveKey });
      storage.put(liveKey, OLD);
      storage.put(orphanKey, OLD);
      storage.failDeletesFor(orphanKey);

      const before = await prisma.series.findUniqueOrThrow({ where: { id } });

      const report = await withApplyEnv(() =>
        service.run({ apply: true, now: SWEEP_NOW }),
      );

      const after = await prisma.series.findUniqueOrThrow({ where: { id } });

      expect(report.failed).toBe(1);
      // The sweep has no DB write path at all — no "deleted" flag to
      // desynchronize — so the row is byte-identical, `updatedAt` included.
      expect(after).toEqual(before);
      expect(storage.has(orphanKey)).toBe(true);
    });

    it('a failed object is simply retried by the next run', async () => {
      const id = seriesId('retry-after-failure');
      const orphanKey = buildSeriesCoverObjectKey(id);
      await createSeries(id);
      storage.put(orphanKey, OLD);
      storage.failDeletesFor(orphanKey);

      const first = await withApplyEnv(() =>
        service.run({ apply: true, now: SWEEP_NOW }),
      );
      expect(first.failed).toBe(1);
      expect(storage.has(orphanKey)).toBe(true);

      // Same fake, but the transient failure is gone: a fresh storage with
      // the same object models "the next sweep, after the outage cleared".
      const healed = new FakeObjectStorage();
      healed.put(orphanKey, OLD);
      const healedService = new SeriesCoverOrphanService(
        prisma,
        asStorageService(healed),
      );

      const second = await withApplyEnv(() =>
        healedService.run({ apply: true, now: SWEEP_NOW }),
      );

      expect(second.deleted).toBe(1);
      expect(healed.size).toBe(0);
    });
  });

  describe('adversarial concurrency — the final pre-delete recheck', () => {
    /**
     * A deterministic barrier, no sleeps and no timer mocking: the sweep's
     * OWN pre-delete recheck (`prisma.series.findFirst`) is wrapped, and the
     * interleaved database write is committed inside that wrapper before the
     * real query runs. The write therefore lands at an exactly known point —
     * after enumeration selected the candidate, before the recheck reads.
     *
     * The stand-in exposes only the two delegate methods the sweep actually
     * uses, each forwarding to the real client, rather than spreading a
     * Prisma instance (whose model delegates are not plain own properties).
     */
    function buildRacingService(
      interleavedWrite: () => Promise<unknown>,
      storageOverride: FakeObjectStorage = storage,
    ): { service: SeriesCoverOrphanService; didInterleave: () => boolean } {
      let interleaved = false;

      const racingPrisma = {
        series: {
          findMany: (args: unknown) =>
            (prisma.series.findMany as (a: unknown) => unknown)(args),
          findFirst: async (args: unknown) => {
            if (!interleaved) {
              interleaved = true;
              await interleavedWrite();
            }
            return (prisma.series.findFirst as (a: unknown) => unknown)(args);
          },
        },
      } as unknown as PrismaService;

      return {
        service: new SeriesCoverOrphanService(
          racingPrisma,
          asStorageService(storageOverride),
        ),
        didInterleave: () => interleaved,
      };
    }

    it('SKIPS a candidate the database referenced between enumeration and deletion', async () => {
      const id = seriesId('race-recheck');
      const key = buildSeriesCoverObjectKey(id);
      await createSeries(id);
      storage.put(key, OLD);

      // "Cleanup selected it, then an admin patch or a completion made it
      // the live cover" — the exact race this recheck exists for.
      const racing = buildRacingService(() =>
        prisma.series.update({
          where: { id },
          data: { coverImageKey: key },
        }),
      );

      const report = await withApplyEnv(() =>
        racing.service.run({ apply: true, now: SWEEP_NOW }),
      );

      expect(racing.didInterleave()).toBe(true);
      expect(report.eligible).toBe(1);
      expect(report.skippedOnRecheck).toBe(1);
      expect(report.deleted).toBe(0);
      // ZERO deletes — the now-live cover survives.
      expect(storage.deleteAttempts).toEqual([]);
      expect(storage.has(key)).toBe(true);
      expect(report.candidates[0].outcome).toBe('skipped-on-recheck');
    });

    it('SKIPS a candidate a PENDING intent reclaimed between enumeration and deletion', async () => {
      const id = seriesId('race-pending');
      const key = buildSeriesCoverObjectKey(id);
      await createSeries(id);
      storage.put(key, OLD);

      const racing = buildRacingService(() =>
        prisma.series.update({
          where: { id },
          data: { pendingCoverImageKey: key },
        }),
      );

      const report = await withApplyEnv(() =>
        racing.service.run({ apply: true, now: SWEEP_NOW }),
      );

      expect(report.skippedOnRecheck).toBe(1);
      expect(report.deleted).toBe(0);
      expect(storage.deleteAttempts).toEqual([]);
    });

    it('SKIPS a candidate a DIFFERENT series adopted between enumeration and deletion', async () => {
      // The recheck queries by KEY across all series, so a cross-series
      // adoption through the raw-key PATCH surface is caught too.
      const ownerId = seriesId('race-cross-owner');
      const adopterId = seriesId('race-cross-adopter');
      const key = buildSeriesCoverObjectKey(ownerId);
      await createSeries(ownerId);
      await createSeries(adopterId);
      storage.put(key, OLD);

      const racing = buildRacingService(() =>
        prisma.series.update({
          where: { id: adopterId },
          data: { coverImageKey: key },
        }),
      );

      const report = await withApplyEnv(() =>
        racing.service.run({ apply: true, now: SWEEP_NOW }),
      );

      expect(report.skippedOnRecheck).toBe(1);
      expect(report.deleted).toBe(0);
      expect(storage.has(key)).toBe(true);
    });

    it('skips only the raced candidate and still removes the others in the same sweep', async () => {
      const id = seriesId('race-partial');
      const keys = [
        buildSeriesCoverObjectKey(id),
        buildSeriesCoverObjectKey(id),
        buildSeriesCoverObjectKey(id),
      ].sort();
      await createSeries(id);
      for (const key of keys) {
        storage.put(key, OLD);
      }

      // Only the FIRST candidate is raced; a skip must be a per-candidate
      // decision, never an abort of the sweep.
      const racing = buildRacingService(() =>
        prisma.series.update({
          where: { id },
          data: { coverImageKey: keys[0] },
        }),
      );

      const report = await withApplyEnv(() =>
        racing.service.run({ apply: true, now: SWEEP_NOW }),
      );

      expect(report.eligible).toBe(3);
      expect(report.skippedOnRecheck).toBe(1);
      expect(report.deleted).toBe(2);
      expect([...storage.deletedKeys].sort()).toEqual(
        [keys[1], keys[2]].sort(),
      );
      expect(storage.has(keys[0])).toBe(true);
    });

    it('DOCUMENTS the one residual window this design does not close', async () => {
      // A reference created strictly BETWEEN the recheck's read and the
      // storage delete is not protected — nothing short of holding a
      // database lock across a network round trip to R2 could close that,
      // and this sweep deliberately does not do that.
      //
      // This test exists so the limitation is PINNED rather than merely
      // documented: if a future change closes the window, this fails and
      // forces the docs and the follow-up list to be updated.
      //
      // Two things bound the real-world risk, both asserted elsewhere in this
      // file: (1) reaching this window at all requires the raw-key
      // PATCH/POST surface or a completion, and (2) the
      // `seriesRecentlyModified` guard already withholds the whole cover
      // namespace of any series touched within the grace window.
      const id = seriesId('residual-window');
      const key = buildSeriesCoverObjectKey(id);
      await createSeries(id);
      storage.put(key, OLD);

      storage.onBeforeDelete = async () => {
        await prisma.series.update({
          where: { id },
          data: { coverImageKey: key },
        });
      };

      const report = await withApplyEnv(() =>
        service.run({ apply: true, now: SWEEP_NOW }),
      );

      expect(report.deleted).toBe(1);
      expect(storage.has(key)).toBe(false);

      // The row now points at a key whose object is gone. That is the exact
      // shape of the residual risk, and it is recoverable: the admin re-runs
      // the normal presign + complete flow.
      const row = await prisma.series.findUniqueOrThrow({ where: { id } });
      expect(row.coverImageKey).toBe(key);
    });
  });

  describe('pagination and request bounds', () => {
    it('pages through a namespace larger than one listing page', async () => {
      const id = seriesId('paged');
      await createSeries(id);
      const keys = Array.from({ length: 7 }, () =>
        buildSeriesCoverObjectKey(id),
      ).sort();
      for (const key of keys) {
        storage.put(key, OLD);
      }

      const pagingService = buildServiceWithPageSize(3);
      const report = await pagingService.run({ now: SWEEP_NOW });

      expect(report.scanned).toBe(7);
      expect(report.eligible).toBe(7);
      // 3 + 3 + 1 — the last page returns no token and ends the loop.
      expect(report.pagesScanned).toBe(3);
      expect(report.listTruncated).toBe(false);
      expect(candidateKeys(report)).toEqual(keys);
    });

    it('forwards the previous page’s token to the next request', async () => {
      const id = seriesId('token-forwarding');
      await createSeries(id);
      for (let index = 0; index < 5; index += 1) {
        storage.put(buildSeriesCoverObjectKey(id), OLD);
      }

      await buildServiceWithPageSize(2).run({ now: SWEEP_NOW });

      expect(storage.listCalls[0].options?.continuationToken).toBeUndefined();
      for (let index = 1; index < storage.listCalls.length; index += 1) {
        expect(
          storage.listCalls[index].options?.continuationToken,
        ).toBeDefined();
      }
    });

    it('never issues more list requests than its page ceiling, even for an endless namespace', async () => {
      const id = seriesId('endless');
      await createSeries(id);
      const endless = new FakeObjectStorage();
      // Always report more pages remaining, whatever is asked for.
      endless.listObjectPageByPrefix = () =>
        Promise.resolve({
          entries: [
            { key: buildSeriesCoverObjectKey(id), lastModified: RECENT },
          ],
          nextContinuationToken: 'always-more',
        });

      const report = await new SeriesCoverOrphanService(
        prisma,
        asStorageService(endless),
      ).run({ now: SWEEP_NOW });

      expect(report.pagesScanned).toBe(SERIES_COVER_ORPHAN_MAX_PAGES);
      expect(report.listTruncated).toBe(true);
    });

    it('issues exactly one reference query and one quiet-period query per page', async () => {
      const id = seriesId('query-bounds');
      await createSeries(id);
      for (let index = 0; index < 4; index += 1) {
        storage.put(buildSeriesCoverObjectKey(id), RECENT);
      }

      const findMany = jest.spyOn(prisma.series, 'findMany');

      await buildServiceWithPageSize(2).run({ now: SWEEP_NOW });

      // 2 pages x 2 queries — bounded by PAGE COUNT, never by object count,
      // which is what rules out an N+1 against the database.
      expect(findMany).toHaveBeenCalledTimes(4);
      findMany.mockRestore();
    });

    /**
     * Builds a service whose sweep uses a smaller page size / page ceiling
     * than production, by wrapping the fake's listing. Keeps the production
     * constants untouched — the bound being tested is the LOOP's, not a
     * test-only configuration knob added to the service.
     */
    function buildServiceWithPageSize(
      pageSize: number,
    ): SeriesCoverOrphanService {
      const bounded = new FakeObjectStorage();
      bounded.listObjectPageByPrefix = (prefix, options) =>
        storage.listObjectPageByPrefix(prefix, {
          ...options,
          maxKeys: pageSize,
        });
      bounded.deleteObject = (key) => storage.deleteObject(key);

      return new SeriesCoverOrphanService(prisma, asStorageService(bounded));
    }
  });

  describe('observability', () => {
    it('reports the grace window and cutoff it actually used', async () => {
      const report = await service.buildReport(SWEEP_NOW);

      expect(report.generatedAt).toEqual(SWEEP_NOW);
      expect(report.graceMs).toBe(SERIES_COVER_ORPHAN_GRACE_MS);
      expect(report.cutoff).toEqual(CUTOFF);
    });

    it('bounds the enumerated candidate list while keeping counters exact', async () => {
      const id = seriesId('candidate-cap');
      await createSeries(id);
      const overCap = SERIES_COVER_ORPHAN_MAX_REPORTED_CANDIDATES + 5;
      for (let index = 0; index < overCap; index += 1) {
        storage.put(buildSeriesCoverObjectKey(id), OLD);
      }

      const report = await service.buildReport(SWEEP_NOW);

      expect(report.eligible).toBe(overCap);
      expect(report.candidates).toHaveLength(
        SERIES_COVER_ORPHAN_MAX_REPORTED_CANDIDATES,
      );
      expect(report.candidatesTruncated).toBe(true);
      expectCountersToSum(report);
    });

    it('never puts a URL or credential into a candidate record', async () => {
      const id = seriesId('no-secrets');
      const key = buildSeriesCoverObjectKey(id);
      await createSeries(id);
      storage.put(key, OLD);

      const report = await service.buildReport(SWEEP_NOW);

      expect(JSON.stringify(report)).not.toMatch(/https?:\/\/|X-Amz-/);
    });
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
