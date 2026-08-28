/**
 * VPS DEPLOYMENT (work unit "TRANSCODE WORKER VPS DEPLOYMENT") — the
 * worker's graceful-shutdown sequence, extracted from `main.ts` so it is a
 * plain testable unit instead of untestable boot wiring.
 *
 * WHAT SIGTERM MUST DO, AND WHY THE ORDER MATTERS. An unattended box
 * restarts the worker constantly: image upgrades, `docker compose up -d`,
 * host reboots, OOM policy. Every one of those sends `SIGTERM` to a process
 * that may be 20 minutes into an FFmpeg encode. The sequence below is
 * ordered so that none of those events can corrupt an output or strand an
 * acknowledged queue job:
 *
 * 1. **Stop the janitor interval first.** It performs destructive R2
 *    deletes. Letting a sweep start while everything else is tearing down
 *    buys nothing and widens the window in which a half-finished delete
 *    races the shutdown.
 * 2. **`worker.close()` — WITHOUT `force`.** This is the load-bearing step.
 *    BullMQ stops fetching NEW jobs immediately and then awaits
 *    `whenCurrentJobsFinished()`, so an in-flight transcode runs to its own
 *    natural boundary: it finishes uploading, validating and promoting, or
 *    it fails and durably records why. Passing `force` here would abandon
 *    the job mid-upload — leaving a partial HLS generation in R2 and a row
 *    stuck `running` — which is exactly the corruption this must prevent.
 * 3. **Close the Nest context**, releasing Prisma and the rest of the graph.
 *
 * BECAUSE STEP 2 IS UNBOUNDED, THE DEPLOYMENT MUST GRANT TIME. Docker's
 * default stop grace is 10 seconds, after which it sends `SIGKILL` — which
 * would defeat every guarantee above. `docker-compose.worker.yml` therefore
 * sets a `stop_grace_period` matched to a realistic encode, and the systemd
 * unit in `docs/TRANSCODE_WORKER_VPS.md` sets `TimeoutStopSec` for the same
 * reason. A job killed anyway is still not LOST: it was never acknowledged
 * as completed, so BullMQ's stalled-job detection redelivers it, and
 * `TranscodeJanitorService.sweepStaleRunning` is the DB-level backstop.
 */

export interface GracefulShutdownDeps {
  /** BullMQ worker. `close()` is called WITHOUT `force` — see above. */
  closeWorker: () => Promise<void>;
  /** Nest application context teardown. */
  closeApp: () => Promise<void>;
  /** Stops the periodic janitor sweep. */
  stopJanitor: () => void;
  log: (message: string) => void;
  logError: (message: string) => void;
}

/**
 * Builds the signal handler. Returns a function safe to register on
 * `SIGTERM` and `SIGINT` both, and safe to call repeatedly.
 *
 * TWO FAILURE MODES THIS EXISTS TO PREVENT, both of which end in `SIGKILL`
 * mid-encode:
 *
 * - **Re-entrancy.** Orchestrators routinely send `SIGTERM` more than once,
 *   and an impatient operator sends `SIGINT` on top of it. Without the
 *   `shuttingDown` latch the second signal calls `worker.close()` and
 *   `app.close()` again while the first drain is still running.
 * - **A rejected teardown.** If `closeWorker` or `closeApp` rejects and
 *   nothing catches it, `onComplete` never fires, the process simply hangs,
 *   and the orchestrator eventually kills it. Every step is therefore
 *   wrapped: a teardown error is logged and shutdown CONTINUES to the next
 *   step, always reaching `onComplete`. Exiting on a best-effort teardown
 *   beats hanging forever on a perfect one.
 */
export function createGracefulShutdown(
  deps: GracefulShutdownDeps,
  onComplete: () => void,
): (signal: string) => void {
  let shuttingDown = false;

  return (signal: string): void => {
    if (shuttingDown) {
      deps.log(
        `Received ${signal} while already shutting down — ignoring (the in-flight job is still being allowed to finish).`,
      );
      return;
    }
    shuttingDown = true;

    deps.log(
      `Received ${signal} — no new jobs will be taken; waiting for the current job to reach a safe boundary...`,
    );

    void (async () => {
      try {
        deps.stopJanitor();
      } catch (error) {
        deps.logError(`Failed to stop the janitor interval: ${brief(error)}`);
      }

      try {
        await deps.closeWorker();
        deps.log('Transcode worker drained — no job was interrupted.');
      } catch (error) {
        deps.logError(`Transcode worker close failed: ${brief(error)}`);
      }

      try {
        await deps.closeApp();
      } catch (error) {
        deps.logError(`Application context close failed: ${brief(error)}`);
      }

      deps.log('Transcode worker shutdown complete.');
      onComplete();
    })();
  };
}

function brief(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
