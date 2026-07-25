import { Test, TestingModule } from '@nestjs/testing';
import { deriveAccessTier } from '../entitlements/entitlement.constants';
import { PrismaService } from './prisma.service';

/**
 * Integration-style spec (Phase 11, work unit 11F-4) covering two properties
 * of the explicit DB-backed access tier that are hard to prove any other
 * way, since the real backfill migration
 * (`prisma/migrations/*_backfill_video_access_tier_override/migration.sql`)
 * and the real `prisma/seed.ts` script both run OUTSIDE the Nest/Jest test
 * harness (a one-time SQL migration, and a standalone `ts-node` script,
 * respectively) — so this spec exercises the SAME logic those two artifacts
 * encode, against safely namespaced, self-cleaning fixture rows, rather than
 * re-running the real migration/script mid-suite (which would either be a
 * no-op against an already-backfilled table, or — if unscoped — risk
 * touching OTHER concurrently-running test files' fixture rows sharing this
 * same dev database; see the existing `*-model.integration.spec.ts` /
 * `video-media-fields.integration.spec.ts` precedent for real `PrismaService`
 * against the project's Postgres database, self-cleaning via `afterEach`).
 */
describe('Video.accessTierOverride backfill + seed-upsert semantics (Prisma integration, 11F-4)', () => {
  let prisma: PrismaService;
  const testIdPrefix = 'video-access-tier-backfill-spec-11f4';
  const seriesId = `${testIdPrefix}-series`;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();

    prisma = module.get<PrismaService>(PrismaService);
    await prisma.onModuleInit();
  });

  afterEach(async () => {
    await prisma.video.deleteMany({ where: { seriesId } });
    await prisma.onModuleDestroy();
  });

  const baseVideoData = {
    seriesId,
    title: 'Backfill Spec Video',
    channelName: 'Spec Channel',
    caption: 'Spec caption',
    category: 'drama',
    storageKey: '',
    sourceLanguage: 'zh',
    hasEmbeddedIndonesianSubtitle: true,
    likeCount: 0,
  };

  describe('backfill UPDATE semantics (mirrors the real backfill migration.sql)', () => {
    /**
     * Runs the SAME `CASE WHEN "episodeNumber" > 5 THEN 'premium' ELSE
     * 'free' END WHERE "accessTierOverride" IS NULL` logic as
     * `prisma/migrations/*_backfill_video_access_tier_override/migration.sql`,
     * with one addition: an `AND "seriesId" = $1` scope. The real migration
     * has no such scope (by design — it must backfill every row in the
     * table, and is safe to run exactly ONCE as part of `prisma migrate`).
     * Re-running that exact unscoped statement here, inside a Jest run that
     * may execute other test files' specs concurrently against this same
     * dev database, would risk filling in another suite's still-in-progress
     * `null`-override fixture row out from under it — the scope clause below
     * exists solely to keep this spec hermetic, not because the real
     * migration is scoped. If `migration.sql`'s CASE/WHERE logic ever
     * changes, keep this in sync.
     */
    async function runScopedBackfill(): Promise<void> {
      await prisma.$executeRawUnsafe(
        `UPDATE "Video"
         SET "accessTierOverride" = CASE WHEN "episodeNumber" > 5 THEN 'premium' ELSE 'free' END
         WHERE "accessTierOverride" IS NULL AND "seriesId" = $1`,
        seriesId,
      );
    }

    it('fills a NULL accessTierOverride with the derived tier for a free episode (episodeNumber <= 5)', async () => {
      await prisma.video.create({
        data: {
          id: `${testIdPrefix}-free-null`,
          ...baseVideoData,
          episodeNumber: 1,
          accessTierOverride: null,
        },
      });

      await runScopedBackfill();

      const row = await prisma.video.findUnique({
        where: { id: `${testIdPrefix}-free-null` },
      });
      expect(row?.accessTierOverride).toBe('free');
    });

    it('fills a NULL accessTierOverride with the derived tier for a premium episode (episodeNumber > 5)', async () => {
      await prisma.video.create({
        data: {
          id: `${testIdPrefix}-premium-null`,
          ...baseVideoData,
          episodeNumber: 6,
          accessTierOverride: null,
        },
      });

      await runScopedBackfill();

      const row = await prisma.video.findUnique({
        where: { id: `${testIdPrefix}-premium-null` },
      });
      expect(row?.accessTierOverride).toBe('premium');
    });

    it('CRITICAL: does NOT overwrite a row that already carries an explicit override, even when it disagrees with the derived default', async () => {
      // episodeNumber 1 would derive to "free", but an admin already set an
      // explicit "premium" override before the backfill ran.
      await prisma.video.create({
        data: {
          id: `${testIdPrefix}-explicit-premium`,
          ...baseVideoData,
          episodeNumber: 1,
          accessTierOverride: 'premium',
        },
      });

      await runScopedBackfill();

      const row = await prisma.video.findUnique({
        where: { id: `${testIdPrefix}-explicit-premium` },
      });
      // Still "premium" — the WHERE "accessTierOverride" IS NULL guard
      // excluded this row entirely; re-running the backfill never reverts
      // an admin's explicit choice back to the derived default.
      expect(row?.accessTierOverride).toBe('premium');
    });
  });

  /**
   * Mirrors `prisma/seed.ts`'s exact upsert shape: `accessTierOverride` is
   * set via `deriveAccessTier` ONLY in the `create` branch, and omitted
   * entirely from the `update` branch — proving that split is what actually
   * preserves an admin's explicit override across a reseed (acceptance
   * criterion: "seed idempotency preserved").
   */
  describe('seed-upsert idempotency (mirrors prisma/seed.ts create/update split)', () => {
    async function upsertLikeSeed(
      id: string,
      episodeNumber: number,
    ): Promise<void> {
      const record = { ...baseVideoData, episodeNumber };
      await prisma.video.upsert({
        where: { id },
        create: {
          id,
          ...record,
          accessTierOverride: deriveAccessTier(episodeNumber),
        },
        update: record,
      });
    }

    it('sets the derived tier on first insert (create)', async () => {
      await upsertLikeSeed(`${testIdPrefix}-seed-create`, 1);

      const row = await prisma.video.findUnique({
        where: { id: `${testIdPrefix}-seed-create` },
      });
      expect(row?.accessTierOverride).toBe('free');
    });

    it('does NOT reset an explicit override back to the derived default when the same id is upserted again (update branch, simulating a reseed)', async () => {
      const id = `${testIdPrefix}-seed-idempotent`;
      await upsertLikeSeed(id, 1); // derives "free"

      // Simulate an admin explicitly overriding it via
      // PATCH /admin/media/:id/access-tier.
      await prisma.video.update({
        where: { id },
        data: { accessTierOverride: 'premium' },
      });

      // Re-run the exact same upsert a second time — simulating
      // `npx prisma db seed` being run again against an already-seeded
      // database.
      await upsertLikeSeed(id, 1);

      const row = await prisma.video.findUnique({ where: { id } });
      // Still "premium" — the update branch never includes
      // accessTierOverride, so a reseed cannot clobber an admin's choice.
      expect(row?.accessTierOverride).toBe('premium');
    });

    it('every other seeded field is still overwritten in place on a re-upsert (idempotency is preserved for the rest of the row)', async () => {
      const id = `${testIdPrefix}-seed-other-fields`;
      await upsertLikeSeed(id, 1);

      await prisma.video.update({
        where: { id },
        data: { title: 'Manually renamed' },
      });

      await upsertLikeSeed(id, 1);

      const row = await prisma.video.findUnique({ where: { id } });
      expect(row?.title).toBe(baseVideoData.title);
    });
  });
});
