import { PrismaClient } from '@prisma/client';
import { VIDEOS } from '../src/videos/videos.data';

/**
 * Seeds the `Video` table from the existing `VIDEOS` array (Phase 8,
 * work unit 8-B4). Imports the array directly instead of retyping the 40
 * records to avoid transcription drift between the seed data and the
 * source-of-truth catalog in `src/videos/videos.data.ts`.
 *
 * Idempotent: uses `upsert` keyed on `id`, so re-running the seed against an
 * already-seeded database updates existing rows in place rather than
 * duplicating or failing on unique-constraint violations.
 */
const prisma = new PrismaClient();

async function main(): Promise<void> {
  for (const record of VIDEOS) {
    await prisma.video.upsert({
      where: { id: record.id },
      create: record,
      update: record,
    });
  }

  // eslint-disable-next-line no-console
  console.log(`Seeded ${VIDEOS.length} Video records.`);
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
