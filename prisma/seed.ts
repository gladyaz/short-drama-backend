import { PrismaClient } from '@prisma/client';
import { deriveAccessTier } from '../src/entitlements/entitlement.constants';
import { VIDEOS } from '../src/videos/videos.data';

/**
 * Seeds the `Video` table from the existing `VIDEOS` array (Phase 8,
 * work unit 8-B4). Imports the array directly instead of retyping the 40
 * records to avoid transcription drift between the seed data and the
 * source-of-truth catalog in `src/videos/videos.data.ts`.
 *
 * `sortOrder` (Phase 8P, work unit 8P-4) is derived from each record's
 * position in the `VIDEOS` array at seed time, rather than hardcoded in a
 * lookup table, so it can never drift from the source file's curated order.
 * This closes the gap flagged in DECISIONS.md ("Phase 8, 8-B4: Video schema
 * decisions") where the original upsert never set `sortOrder`, which would
 * have left every freshly seeded row tied at the schema default (0).
 *
 * Idempotent: uses `upsert` keyed on `id`, so re-running the seed against an
 * already-seeded database updates existing rows (including `sortOrder`) in
 * place rather than duplicating or failing on unique-constraint violations.
 *
 * Work unit 11F-4: `accessTierOverride` is set ONLY in the `create` branch
 * of the upsert, to `deriveAccessTier(episodeNumber)` — the same free/
 * premium rule the (now-applied, additive) backfill migration used to
 * populate every pre-existing row. This means a fresh `prisma migrate reset`
 * (which runs every migration — including the backfill, a no-op on an empty
 * table — before this seed script populates the 40 rows) still ends up with
 * every row carrying an explicit tier, not `null`. It is deliberately
 * OMITTED from the `update` branch: re-running this seed against an
 * already-seeded database must never reset an admin's explicit override
 * (set via `PATCH /admin/media/:id/access-tier`) back to the derived
 * default, matching the existing precedent that `update` never touches any
 * other admin-settable additive column (`lifecycleState`, object-storage
 * keys, etc. are likewise absent from `record` and therefore untouched here).
 */
const prisma = new PrismaClient();

async function main(): Promise<void> {
  const records = VIDEOS.map((record, index) => ({
    ...record,
    sortOrder: index,
  }));

  for (const record of records) {
    await prisma.video.upsert({
      where: { id: record.id },
      create: {
        ...record,
        accessTierOverride: deriveAccessTier(record.episodeNumber),
      },
      update: record,
    });
  }

  // eslint-disable-next-line no-console
  console.log(`Seeded ${records.length} Video records.`);
}

main()
  .catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
