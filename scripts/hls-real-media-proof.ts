import 'dotenv/config';
import { createHash } from 'crypto';
import { readFile, stat } from 'fs/promises';
import { basename } from 'path';
import { NestFactory } from '@nestjs/core';
import { PrismaService } from '../src/prisma/prisma.service';
import { StorageService } from '../src/storage/storage.service';
import { buildSourceObjectKey } from '../src/media/media-storage-key.util';
import { TranscodeIntentService } from '../src/transcode/transcode-intent.service';
import { buildTranscodeJobId } from '../src/transcode/transcode.constants';
import { WorkerModule } from '../src/worker/worker.module';

/**
 * The REAL-media counterpart to `hls-local-proof.ts`.
 *
 * `hls-local-proof.ts` proves the ffmpeg/HLS pipeline in isolation against a
 * SYNTHETIC source, deliberately bypassing the queue, the database, and object
 * storage (see `HlsModule`'s doc comment for that slice's queue-boundary
 * rationale). That leaves the actual production path — a real episode
 * travelling `source MP4 -> BullMQ -> Redis -> worker -> ffmpeg -> HLS ->
 * playback resolver` — with no runnable end-to-end proof at all, because the
 * ONLY thing that ever enqueues a transcode job is
 * `AdminMediaService.completeUpload`, which requires the full authenticated
 * admin upload flow.
 *
 * This script is the missing PRODUCER half. It does exactly two things, then
 * stops:
 *
 *   1. **Seed** — uploads one real source file to the canonical
 *      `admin-media/<mediaId>/source` key (`buildSourceObjectKey`, the SAME
 *      key `TranscodeJobProcessor` downloads from) and upserts a single
 *      `Video` row for it.
 *   2. **Enqueue** — calls the REAL `TranscodeIntentService.requestProcessing`,
 *      which performs the real atomic DB intent write and the real
 *      `BullmqTranscodeQueueClient.add` against the real Redis instance.
 *
 * It NEVER transcodes anything itself and never invokes ffmpeg. Consuming the
 * job is the dedicated worker's job — run it separately, exactly as production
 * would:
 *
 *   npm run build && TRANSCODE_ENABLED=true node dist/worker/main
 *
 * ## Blast radius
 *
 * Writes exactly ONE `Video` row (`--media-id`, default derived
 * deterministically from the source path) and exactly ONE object
 * (`admin-media/<mediaId>/source`). It never touches, reads, or updates any
 * other catalog row, and never mass-updates anything. The row is created as
 * `contentKind: "qa_fixture"` — the established classification for an internal
 * technical fixture that must stay streamable for QA but must never render as
 * consumer catalog content (see `VideoContentKind`) — matching the existing
 * `media-11rqa-8ac6a7f3` HLS sample row's precedent exactly.
 *
 * ## Idempotency
 *
 * Re-running with the same `--media-id` re-uploads the same source to the same
 * deterministic key (an overwrite of identical bytes), upserts the same row,
 * and requests a NEW `processingVersion`. That is the intended retry
 * semantics: a fresh generation supersedes the previous one, gets its own
 * immutable staging prefix (`buildHlsStagingPrefix`), and can never corrupt or
 * partially overwrite the currently-live generation — see
 * `TranscodeIntentService.promoteIfCurrent`'s doc comment.
 *
 * Usage:
 *
 *   npm run hls:real-media-proof -- --source "/abs/path/to/episode.mp4"
 *   npm run hls:real-media-proof -- --source "..." --media-id media-hlsproof-x
 */

interface ProofArgs {
  sourcePath: string;
  mediaId: string;
  seriesId: string;
  title: string;
  episodeNumber: number;
}

/** `contentKind` for the seeded row — never `"drama"`, so no consumer catalog ever renders it. */
const PROOF_CONTENT_KIND = 'qa_fixture';

/**
 * Seeded rows are FREE so `/videos/:id/playback` can be exercised without an
 * entitlement — the proof's subject is the HLS resolution path, not the
 * premium gate (which `VideosController#enforceEntitlementGate` covers
 * independently).
 */
const PROOF_ACCESS_TIER = 'free';

const SOURCE_CONTENT_TYPE = 'video/mp4';

function parseArgs(argv: readonly string[]): ProofArgs {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const sourcePath = flag('source');
  if (!sourcePath) {
    throw new Error(
      'Missing required --source <absolute path to the episode MP4>',
    );
  }

  // Deterministic default so a re-run without an explicit --media-id reuses
  // the SAME row and the SAME source key rather than silently accumulating a
  // new fixture row (and a new orphaned source object) per invocation.
  const defaultMediaId = `media-hlsproof-${createHash('sha256')
    .update(sourcePath)
    .digest('hex')
    .slice(0, 12)}`;

  return {
    sourcePath,
    mediaId: flag('media-id') ?? defaultMediaId,
    seriesId: flag('series-id') ?? 'series-hlsproof',
    title: flag('title') ?? `HLS proof — ${basename(sourcePath)}`,
    episodeNumber: Number(flag('episode') ?? '1'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (process.env.TRANSCODE_ENABLED !== 'true') {
    throw new Error(
      'TRANSCODE_ENABLED must be exactly "true" for this script — otherwise ' +
        'TranscodeModule provides the inert NoopTranscodeQueueClient and the ' +
        'enqueue below would silently do nothing.',
    );
  }

  const sourceStats = await stat(args.sourcePath);
  if (!sourceStats.isFile()) {
    throw new Error(`--source is not a file: ${args.sourcePath}`);
  }

  const app = await NestFactory.createApplicationContext(
    WorkerModule.register(),
    { logger: ['warn', 'error'] },
  );

  try {
    const prisma = app.get(PrismaService);
    const storageService = app.get(StorageService);
    const intentService = app.get(TranscodeIntentService);

    // 1. Seed the source object at the canonical key the worker downloads from.
    const sourceKey = buildSourceObjectKey(args.mediaId);
    const body = await readFile(args.sourcePath);
    await storageService.putObject(sourceKey, body, SOURCE_CONTENT_TYPE);

    const head = await storageService.headObject(sourceKey);
    if (!head || head.contentLength !== body.byteLength) {
      throw new Error(
        `Source upload could not be verified for key "${sourceKey}"`,
      );
    }

    // 2. Upsert exactly one Video row for it. `storageKey: ''` is this repo's
    //    established "no local file" representation (see VideosService#findAll's
    //    OR clause) — this row is R2-backed only, so local MP4 streaming is
    //    never implied for it.
    await prisma.video.upsert({
      where: { id: args.mediaId },
      create: {
        id: args.mediaId,
        seriesId: args.seriesId,
        title: args.title,
        episodeNumber: args.episodeNumber,
        channelName: 'HLS Proof',
        caption: 'Internal HLS transcoding proof fixture.',
        category: 'drama',
        storageKey: '',
        sourceLanguage: 'zh',
        hasEmbeddedIndonesianSubtitle: true,
        likeCount: 0,
        objectStorageKey: sourceKey,
        lifecycleState: 'published',
        contentKind: PROOF_CONTENT_KIND,
        accessTierOverride: PROOF_ACCESS_TIER,
        expectedSizeBytes: body.byteLength,
        expectedContentType: SOURCE_CONTENT_TYPE,
      },
      update: {
        objectStorageKey: sourceKey,
        expectedSizeBytes: body.byteLength,
        expectedContentType: SOURCE_CONTENT_TYPE,
      },
    });

    // 3. The REAL intent write + REAL BullMQ enqueue.
    const processingVersion = await intentService.requestProcessing(
      args.mediaId,
    );

    const summary = {
      mediaId: args.mediaId,
      sourcePath: args.sourcePath,
      sourceKey,
      sourceSizeBytes: body.byteLength,
      processingVersion,
      jobId: buildTranscodeJobId(args.mediaId, processingVersion),
      nextStep:
        'Run the worker to consume it: TRANSCODE_ENABLED=true node dist/worker/main',
    };

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary, null, 2));
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
