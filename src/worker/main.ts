import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { redactSensitiveText } from '../common/logging/redact';
import { RootConfig } from '../config/configuration';
import { TranscodeJanitorService } from '../transcode/transcode-janitor.service';
import { TranscodeJobProcessor } from '../transcode/transcode-job-processor.service';
import {
  resolveWorkerTempRoot,
  sweepStaleWorkerTempDirs,
} from '../transcode/transcode-temp';
import { TRANSCODE_JANITOR_INTERVAL_MS } from '../transcode/transcode.constants';
import { startTranscodeWorker } from './transcode-worker';
import { createGracefulShutdown } from './worker-shutdown';
import { WorkerModule } from './worker.module';
import { WorkerReadinessService } from './worker-readiness.service';

/**
 * Slice 11O — the dedicated FFmpeg/HLS worker entry point (proposal §1,
 * 2026-08-10 approval binding constraint 2). A NestJS STANDALONE application
 * context (`NestFactory.createApplicationContext`) — there is no
 * `app.listen()` anywhere in this file, no HTTP port is ever opened, and
 * FFmpeg never runs inside `AppModule`'s HTTP request path.
 *
 * Independently runnable: `node dist/worker/main` (after `nest build` — see
 * the report's "worker entry + how to run it" section for the exact build
 * verification). No CLI flags/modes beyond this one boot-and-exit path in
 * this slice — the approval's scope is the "worker start smoke" only; the
 * full local synthetic FFmpeg/HLS proof runs via the separate
 * `scripts/hls-local-proof.ts` (and the gated real-R2 proof via the opt-in
 * `hls-r2-smoke.spec.ts`), neither of which this file invokes, so a plain
 * `node dist/worker/main` NEVER runs ffmpeg and NEVER touches the network.
 *
 * Boots `WorkerModule`, logs a secret-free readiness summary (ffmpeg/ffprobe
 * presence via the injected `FfmpegAvailabilityClient`, plus a config
 * summary containing only booleans/enum-like strings — never a secret,
 * value, credential, or absolute internal path), then branches on
 * `TRANSCODE_ENABLED`:
 *
 * - **`false` (default smoke mode, unchanged from Slice 11O — this repo's
 *   only shipped state):** closes the application context and returns
 *   (the caller below exits `0`). Never starts a worker, never touches
 *   Redis.
 * - **`true` (Slice 11P persistent worker mode, isolated test/dev
 *   conditions ONLY — never this repo's real default, per the 2026-08-10
 *   approval's binding constraint 13):** starts the real BullMQ transcode
 *   worker (`startTranscodeWorker`) and keeps this application context OPEN
 *   INDEFINITELY (the returned promise does not resolve) until an operator
 *   sends `SIGTERM`/`SIGINT`, at which point the worker and the application
 *   context are closed gracefully before the process exits `0`. This is
 *   what makes `node dist/worker/main` under `TRANSCODE_ENABLED=true` behave
 *   like a normal long-running worker process (matching the proposal's
 *   "Prod v1 ... worker (`node dist/worker`) under pm2/systemd as a separate
 *   service" topology) instead of the smoke-mode boot-and-exit.
 */
export async function bootstrapWorker(): Promise<void> {
  const app = await NestFactory.createApplicationContext(
    WorkerModule.register(),
    {
      logger: ['log', 'warn', 'error'],
    },
  );

  const logger = new Logger('Worker');
  const readinessService = app.get(WorkerReadinessService);
  const summary = await readinessService.check();

  logger.log(
    redactSensitiveText(
      `short-drama-backend worker starting — ${JSON.stringify(summary)}`,
    ),
  );

  if (!summary.config.transcodeEnabled) {
    await app.close();
    return;
  }

  const configService = app.get<ConfigService<RootConfig>>(ConfigService);
  const transcodeConfig = configService.get('transcode', { infer: true })!;

  // VPS DEPLOYMENT: reclaim scratch left behind by a PREVIOUS run that was
  // killed mid-job (SIGKILL/OOM/power loss skips the processor's own
  // `finally` cleanup). Runs BEFORE the worker starts taking jobs, so a
  // worker restarting into a nearly-full disk gets its headroom back first
  // rather than failing its next job for a reason unrelated to that job.
  // Age-bounded so it can never delete a directory a concurrently-running
  // worker still owns — see `sweepStaleWorkerTempDirs`.
  const tempRoot = await resolveWorkerTempRoot(transcodeConfig.tempDir);
  const tempSweepMinAgeMs = transcodeConfig.tempSweepMinAgeMinutes * 60_000;
  const startupSweep = await sweepStaleWorkerTempDirs({
    root: tempRoot,
    minAgeMs: tempSweepMinAgeMs,
    onError: (message) => logger.warn(redactSensitiveText(message)),
  });
  logger.log(
    `Startup temp sweep — ${JSON.stringify(startupSweep)} (root exists, age threshold ${transcodeConfig.tempSweepMinAgeMinutes}m).`,
  );

  const processor = app.get(TranscodeJobProcessor);
  const worker = startTranscodeWorker(
    transcodeConfig.redisUrl!,
    processor,
    transcodeConfig.workerConcurrency,
  );

  logger.log(
    `Transcode worker started — persistent mode (TRANSCODE_ENABLED=true), concurrency ${transcodeConfig.workerConcurrency}.`,
  );

  // Slice 11P: periodic janitor sweeps — `TranscodeJanitorService`'s own
  // methods are the tested, injectable foundation (see its doc comment);
  // this `setInterval` is the thin, deliberately untested-by-design
  // scheduling wrapper around them (mirrors `startTranscodeWorker`'s own
  // "never construct/exercise the real long-running thing in a unit test"
  // precedent). Runs only in this same flag-gated persistent-mode branch —
  // `TRANSCODE_ENABLED=false` (this repo's shipped default) never registers
  // this interval at all.
  const janitor = app.get(TranscodeJanitorService);
  const janitorInterval = setInterval(() => {
    void janitor
      .sweepStaleRunning()
      .catch((error: unknown) =>
        logger.error(
          redactSensitiveText(
            `Janitor sweepStaleRunning failed: ${String(error)}`,
          ),
        ),
      );
    void janitor
      .cleanupOrphanStaging()
      .catch((error: unknown) =>
        logger.error(
          redactSensitiveText(
            `Janitor cleanupOrphanStaging failed: ${String(error)}`,
          ),
        ),
      );
    // The startup sweep alone would leave a worker that stays up for weeks
    // accumulating scratch from every crash in between. `sweepStaleWorkerTempDirs`
    // never throws, so this needs no `.catch` of its own.
    void sweepStaleWorkerTempDirs({
      root: tempRoot,
      minAgeMs: tempSweepMinAgeMs,
      onError: (message) => logger.warn(redactSensitiveText(message)),
    });
  }, TRANSCODE_JANITOR_INTERVAL_MS);

  await new Promise<void>((resolve) => {
    const shutdown = createGracefulShutdown(
      {
        // NO `force` — BullMQ stops fetching new jobs and then waits for the
        // in-flight one to finish. See `worker-shutdown.ts` for the full
        // ordering rationale and for why the deployment must grant a stop
        // grace period long enough to let this complete.
        closeWorker: () => worker.close(),
        closeApp: () => app.close(),
        stopJanitor: () => clearInterval(janitorInterval),
        log: (message) => logger.log(message),
        logError: (message) => logger.error(redactSensitiveText(message)),
      },
      resolve,
    );

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  });
}

// Process-level last-resort handlers, mirroring `../main.ts`'s convention —
// both routed through the redaction layer so a raw error message (which
// could embed a filesystem path or connection detail) never reaches stdout
// unredacted.
const processLogger = new Logger('WorkerProcess');

process.on('unhandledRejection', (reason) => {
  const detail =
    reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  processLogger.error(
    redactSensitiveText(`Unhandled promise rejection: ${detail}`),
  );
});

process.on('uncaughtException', (error) => {
  processLogger.error(
    redactSensitiveText(`Uncaught exception: ${error.stack ?? error.message}`),
  );
  process.exit(1);
});

// Only auto-run when this file is the process entry point (`node
// dist/worker/main`) — `require.main === module` is `false` when Jest (or
// any other importer) requires this module, so importing `main.ts` in a
// test never triggers a real boot. This mirrors `../main.ts`'s
// unconditional `void bootstrap()` for the ACTUAL entry point while staying
// import-safe for `main.spec.ts`.
if (require.main === module) {
  bootstrapWorker()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      processLogger.error(
        redactSensitiveText(
          `Worker failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        ),
      );
      process.exit(1);
    });
}
