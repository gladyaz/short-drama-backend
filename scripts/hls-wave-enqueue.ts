import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { PrismaService } from '../src/prisma/prisma.service';
import { StorageService } from '../src/storage/storage.service';
import { buildSourceObjectKey } from '../src/media/media-storage-key.util';
import { computeRenditionLadder } from '../src/transcode/hls/rendition-ladder';
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
 * ## `--dry-run`
 *
 * The default is NOT a dry run — `--dry-run` must be passed explicitly. A dry
 * run runs every preflight check above and reports, per candidate: the id, the
 * source key, whether the source is expected to be there, portrait/landscape
 * eligibility, the ladder the recorded dimensions imply, whether it WOULD be
 * enqueued, and the reason if not. It performs ZERO database writes, ZERO
 * BullMQ writes and ZERO object-storage writes — the only calls it makes are a
 * `findUnique` and a `HEAD`, both read-only — and it exits non-zero unless
 * every requested id would be enqueued, so it is usable as a gate.
 *
 * Usage:
 *
 *   npm run hls:wave-enqueue -- --ids=video-101-01,video-101-02 --dry-run
 *   npm run hls:wave-enqueue -- --ids=video-101-01,video-101-02
 */

interface EpisodeOutcome {
  videoId: string;
  /** Whether this run actually enqueued. Always `false` under `--dry-run`. */
  enqueued: boolean;
  /**
   * Whether a REAL run would enqueue this episode. Under `--dry-run` this is
   * the answer the operator is actually asking for; `enqueued` above only
   * ever reports what this specific invocation did.
   */
  wouldEnqueue: boolean;
  reason?: string;
  processingVersion?: number;
  jobId?: string;
  enqueuedAt?: string;
  width?: number | null;
  height?: number | null;
  /** Always populated — it is a pure function of the id, so it is known even for a row that does not exist. */
  sourceKey: string;
  sourceExpectation?: string;
  sourceBytes?: number;
  /** Rung names the ladder would produce from the CATALOG dimensions. See `previewLadder`. */
  expectedLadder?: string[];
  expectedLadderCaveat?: string;
}

/**
 * The rungs `computeRenditionLadder` would choose from the row's RECORDED
 * `width`/`height` alone. This is a PREVIEW, not a promise: the worker
 * re-probes the source and ladders on the probed, post-rotation dimensions,
 * which is the only authority. A row whose recorded dimensions disagree with
 * its actual file, or whose file carries display rotation, will produce a
 * different ladder — hence the caveat carried alongside it in the report.
 */
function previewLadder(width: number, height: number): string[] {
  return computeRenditionLadder({
    width,
    height,
    // Not knowable from the database: the catalog stores no rotation, fps,
    // or audio flag. These three placeholders do not affect WHICH rungs are
    // selected (that is decided by the post-rotation short side alone), only
    // the fps/audio fields of the result, which this preview ignores.
    rotation: 0,
    fps: 30,
    hasAudio: true,
    durationSeconds: 0,
    videoCodec: 'h264',
  }).rungs.map((rung) => `${rung.name} ${rung.width}x${rung.height}`);
}

const LADDER_CAVEAT =
  'Preview only — derived from the catalog width/height. The worker ' +
  're-probes the source and ladders on the probed, post-rotation ' +
  'dimensions, which may differ.';

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
      // Pure function of the id, so it is knowable even for a row that does
      // not exist — an operator chasing a `ROW_NOT_FOUND` still gets told
      // which key this wave would have looked for.
      const sourceKey = buildSourceObjectKey(videoId);
      const skip = (reason: string, extra: Partial<EpisodeOutcome> = {}) => {
        outcomes.push({
          videoId,
          enqueued: false,
          wouldEnqueue: false,
          reason,
          sourceKey,
          ...extra,
        });
      };

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
        skip('ROW_NOT_FOUND');
        continue;
      }
      if (row.lifecycleState !== 'published') {
        skip(`NOT_PUBLISHED (${row.lifecycleState})`);
        continue;
      }

      // Portrait gate. `width`/`height` are the catalog's own recorded
      // dimensions; a row with neither recorded cannot be proven portrait
      // from the database alone, so it is refused rather than assumed.
      if (row.width === null || row.height === null) {
        skip('DIMENSIONS_UNKNOWN — cannot prove portrait');
        continue;
      }
      if (row.width >= row.height) {
        skip(`NOT_PORTRAIT (${row.width}x${row.height})`, {
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
        skip(`ALREADY_IN_FLIGHT (${row.processingState})`, {
          width: row.width,
          height: row.height,
        });
        continue;
      }

      const head = await storageService.headObject(sourceKey);

      if (!head || head.contentLength === 0) {
        skip(head ? 'SOURCE_EMPTY' : 'SOURCE_MISSING', {
          width: row.width,
          height: row.height,
          sourceExpectation: head
            ? 'present but ZERO bytes'
            : 'absent — run the R2 media migration for this row first',
        });
        continue;
      }

      const eligible = {
        width: row.width,
        height: row.height,
        sourceKey,
        sourceExpectation: 'present and non-empty (HEAD verified)',
        sourceBytes: head.contentLength,
        expectedLadder: previewLadder(row.width, row.height),
        expectedLadderCaveat: LADDER_CAVEAT,
      };

      if (dryRun) {
        outcomes.push({
          videoId,
          enqueued: false,
          wouldEnqueue: true,
          reason: 'DRY_RUN (all preflight checks passed — nothing was written)',
          ...eligible,
        });
        continue;
      }

      const processingVersion = await intentService.requestProcessing(videoId);

      outcomes.push({
        videoId,
        enqueued: true,
        wouldEnqueue: true,
        processingVersion,
        jobId: buildTranscodeJobId(videoId, processingVersion),
        enqueuedAt: new Date().toISOString(),
        ...eligible,
      });
    }

    const enqueued = outcomes.filter((o) => o.enqueued).length;
    const wouldEnqueue = outcomes.filter((o) => o.wouldEnqueue).length;

    console.log(
      JSON.stringify(
        {
          requested: ids.length,
          enqueued,
          wouldEnqueue,
          dryRun,
          writes: dryRun
            ? {
                database: 0,
                bullmq: 0,
                objectStorage: 0,
                note: 'A dry run performs read-only queries and read-only HEADs. Nothing is written anywhere.',
              }
            : undefined,
          outcomes,
        },
        null,
        2,
      ),
    );

    // A wave that could not enqueue everything asked for is a failure, so the
    // exit code is usable as a gate without parsing the JSON above. A DRY RUN
    // is held to the same standard against `wouldEnqueue` — otherwise the
    // preflight gate an operator is supposed to run FIRST would exit 0 while
    // silently reporting that three of five episodes are not eligible.
    process.exitCode =
      (dryRun ? wouldEnqueue : enqueued) === ids.length ? 0 : 1;
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});
