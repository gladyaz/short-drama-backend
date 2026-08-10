import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { redactSensitiveText } from '../common/logging/redact';
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
 * value, credential, or absolute internal path), closes the application
 * context, and exits `0`.
 */
export async function bootstrapWorker(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['log', 'warn', 'error'],
  });

  const logger = new Logger('Worker');

  try {
    const readinessService = app.get(WorkerReadinessService);
    const summary = await readinessService.check();

    logger.log(
      redactSensitiveText(
        `short-drama-backend worker starting — ${JSON.stringify(summary)}`,
      ),
    );
  } finally {
    await app.close();
  }
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
