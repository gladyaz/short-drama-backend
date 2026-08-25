import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { PrismaService } from '../src/prisma/prisma.service';
import { StorageService } from '../src/storage/storage.service';
import { buildSourceObjectKey } from '../src/media/media-storage-key.util';
import { TranscodeIntentService } from '../src/transcode/transcode-intent.service';
import { buildTranscodeJobId } from '../src/transcode/transcode.constants';
import { WorkerModule } from '../src/worker/worker.module';

/**
 * Enqueues transcode jobs for EXISTING catalog rows, by explicit id.
 *
 * This is the producer half of a controlled wave. It is deliberately NOT
 * `hls-real-media-proof.ts`: that script seeds a source object and UPSERTS a
 * `Video` row, which is exactly right for creating a disposable fixture and
 * exactly wrong here — a wave runs against rows that already exist, and
 * re-running an upsert against a real catalog row would rewrite columns the
 * wave has no business touching. This script never writes a row it did not
 * find, never uploads anything, and never touches object storage except to
 * READ (a HEAD to confirm the source is really there).
 *
 * The queue path itself is unchanged and unmocked: it calls the real
 * `TranscodeIntentService.requestProcessing`, which performs the real atomic
 * intent write and the real `BullmqTranscodeQueueClient.add` against real
 * Redis. FFmpeg is never invoked here — a separately-running
 * `node dist/worker/main` consumes the jobs, exactly as production would.
 *
 * ## Per-episode preflight (all must pass, or that episode is SKIPPED)
 *
 * Each id is checked independently and a failure skips only that episode —
 * never the whole wave, and never silently:
 *
 *  1. the row exists and is `published`;
 *  2. its recorded dimensions describe PORTRAIT media (short side is the
 *     width) — a landscape row is refused outright, because a wave scoped to
 *     portrait content must not quietly widen;
 *  3. the source object exists in storage at the canonical
 *     `admin-media/<id>/source` key and is non-empty;
 *  4. the row is not already mid-flight (`queued`/`running`), so a wave can
 *     never stack a second generation on top of one still being processed.
 *
 * Usage:
 *
 *   npm run hls:wave-enqueue -- --ids=video-101-01,video-101-02
 *   npm run hls:wave-enqueue -- --ids=... --dry-run
 */

interface EpisodeOutcome {
  videoId: string;
  enqueued: boolean;
  reason?: string;
  processingVersion?: number;
  jobId?: string;
  enqueuedAt?: string;
  width?: number | null;
  height?: number | null;
  sourceKey?: string;
  sourceBytes?: number;
}

function parseIds(argv: readonly string[]): string[] {
  const arg = argv.find((a) => a.startsWith('--ids='));
  if (!arg) {
    throw new Error(
      'Missing required --ids=<comma-separated Video ids>, e.g. --ids=video-101-01,video-101-02',
    );
  }

  const ids = arg
    .slice('--ids='.length)
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  if (ids.length === 0) {
    throw new Error('--ids must name at least one Video id.');
  }

  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicates.length > 0) {
    throw new Error(
      `--ids contains duplicate id(s): ${[...new Set(duplicates)].join(', ')}.`,
    );
  }

  return ids;
}

async function main(): Promise<void> {
  const ids = parseIds(process.argv.slice(2));
  const dryRun = process.argv.includes('--dry-run');

  if (process.env.TRANSCODE_ENABLED !== 'true') {
    throw new Error(
      'TRANSCODE_ENABLED must be exactly "true" — otherwise TranscodeModule ' +
        'provides the inert NoopTranscodeQueueClient and every enqueue below ' +
        'would silently do nothing.',
    );
  }

  const app = await NestFactory.createApplicationContext(
    WorkerModule.register(),
    { logger: ['warn', 'error'] },
  );

  const outcomes: EpisodeOutcome[] = [];

  try {
    const prisma = app.get(PrismaService);
    const storageService = app.get(StorageService);
    const intentService = app.get(TranscodeIntentService);

    for (const videoId of ids) {
      const row = await prisma.video.findUnique({
        where: { id: videoId },
        select: {
          id: true,
          seriesId: true,
          episodeNumber: true,
          lifecycleState: true,
          width: true,
          height: true,
          processingState: true,
          processingVersion: true,
        },
      });

      if (!row) {
        outcomes.push({ videoId, enqueued: false, reason: 'ROW_NOT_FOUND' });
        continue;
      }
      if (row.lifecycleState !== 'published') {
        outcomes.push({
          videoId,
          enqueued: false,
          reason: `NOT_PUBLISHED (${row.lifecycleState})`,
        });
        continue;
      }

      // Portrait gate. `width`/`height` are the catalog's own recorded
      // dimensions; a row with neither recorded cannot be proven portrait
      // from the database alone, so it is refused rather than assumed.
      if (row.width === null || row.height === null) {
        outcomes.push({
          videoId,
          enqueued: false,
          reason: 'DIMENSIONS_UNKNOWN — cannot prove portrait',
        });
        continue;
      }
      if (row.width >= row.height) {
        outcomes.push({
          videoId,
          enqueued: false,
          reason: `NOT_PORTRAIT (${row.width}x${row.height})`,
          width: row.width,
          height: row.height,
        });
        continue;
      }

      // Already mid-flight: never stack a second generation on a run that is
      // still going. (A `ready`/`failed`/null row is fine to (re)queue.)
      if (
        row.processingState === 'queued' ||
        row.processingState === 'running'
      ) {
        outcomes.push({
          videoId,
          enqueued: false,
          reason: `ALREADY_IN_FLIGHT (${row.processingState})`,
        });
        continue;
      }

      const sourceKey = buildSourceObjectKey(videoId);
      const head = await storageService.headObject(sourceKey);

      if (!head || head.contentLength === 0) {
        outcomes.push({
          videoId,
          enqueued: false,
          reason: head ? 'SOURCE_EMPTY' : 'SOURCE_MISSING',
          sourceKey,
        });
        continue;
      }

      if (dryRun) {
        outcomes.push({
          videoId,
          enqueued: false,
          reason: 'DRY_RUN (all preflight checks passed)',
          width: row.width,
          height: row.height,
          sourceKey,
          sourceBytes: head.contentLength,
        });
        continue;
      }

      const processingVersion = await intentService.requestProcessing(videoId);

      outcomes.push({
        videoId,
        enqueued: true,
        processingVersion,
        jobId: buildTranscodeJobId(videoId, processingVersion),
        enqueuedAt: new Date().toISOString(),
        width: row.width,
        height: row.height,
        sourceKey,
        sourceBytes: head.contentLength,
      });
    }

    const enqueued = outcomes.filter((o) => o.enqueued).length;

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        { requested: ids.length, enqueued, dryRun, outcomes },
        null,
        2,
      ),
    );

    // A wave that could not enqueue everything asked for is a failure, so the
    // exit code is usable as a gate without parsing the JSON above.
    process.exitCode = dryRun || enqueued === ids.length ? 0 : 1;
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});
