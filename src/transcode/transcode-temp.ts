import { mkdir, readdir, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { TRANSCODE_WORKER_TEMP_DIR_PREFIX } from './transcode.constants';

/**
 * VPS DEPLOYMENT (work unit "TRANSCODE WORKER VPS DEPLOYMENT") — the
 * worker's temp-scratch lifecycle, split out of `main.ts` so it is a plain
 * testable unit rather than another piece of untested boot wiring.
 *
 * Three separate guarantees combine to bound disk growth, and it is worth
 * being precise about which one covers which failure:
 *
 * 1. **Per-job isolation + cleanup** — `TranscodeJobProcessor.process`
 *    creates a fresh `fs.mkdtemp` directory per job and removes it in a
 *    `finally`, so a job that SUCCEEDS or FAILS normally leaves nothing
 *    behind. That is the common case and it is handled entirely there.
 * 2. **Crash recovery (this file)** — a `SIGKILL`, an OOM kill, or a power
 *    loss skips that `finally` entirely, stranding a directory that can hold
 *    a multi-GB source plus a full HLS package. Nothing else in the system
 *    ever reclaims it: `TranscodeJanitorService.cleanupOrphanStaging` sweeps
 *    R2 object storage, not the worker's LOCAL disk. Without this sweep a
 *    crash-looping worker fills the disk and then fails every subsequent
 *    job for a reason with no obvious connection to the original crash.
 * 3. **Bounded blast radius** — the sweep only ever considers entries whose
 *    name starts with this pipeline's own `mkdtemp` prefix, and only those
 *    older than `minAgeMs`. It therefore cannot touch another application's
 *    files sharing the same `/tmp`, and cannot delete a directory belonging
 *    to a CONCURRENT worker's still-running job (see
 *    `DEFAULT_TRANSCODE_TEMP_SWEEP_MIN_AGE_MINUTES` for why the default
 *    threshold sits above the stalled-row window).
 */

/**
 * Resolves the parent directory per-job temp directories are created under,
 * and guarantees it EXISTS.
 *
 * `os.tmpdir()` is always present, but a configured `TRANSCODE_TEMP_DIR`
 * pointing at a freshly-mounted container volume very often is not — and a
 * missing parent makes `fs.mkdtemp` fail with an `ENOENT` naming a path the
 * operator never typed (`/data/transcode-tmp/11p-transcode-worker-XXXXXX`),
 * which reads like a bug rather than "create this directory". Creating it
 * here, once at startup, turns that into a non-event.
 */
export async function resolveWorkerTempRoot(
  configuredTempDir: string | undefined,
): Promise<string> {
  const root = configuredTempDir ?? tmpdir();
  await mkdir(root, { recursive: true });
  return root;
}

/** Injectable filesystem seam, so the sweep's own tests never touch a real disk. */
export interface WorkerTempFs {
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ mtimeMs: number }>;
  rm(path: string): Promise<void>;
}

const REAL_FS: WorkerTempFs = {
  readdir: (path) => readdir(path),
  stat: async (path) => {
    const stats = await stat(path);
    return { mtimeMs: stats.mtimeMs };
  },
  rm: (path) => rm(path, { recursive: true, force: true }),
};

export interface StaleTempSweepResult {
  /** Directories actually removed. */
  removed: number;
  /** Prefix-matching directories left alone because they were younger than `minAgeMs`. */
  skippedTooYoung: number;
  /** Prefix-matching directories a per-entry error prevented removing. */
  failed: number;
}

/**
 * Removes stranded per-job temp directories under `root`.
 *
 * NEVER THROWS, and never aborts partway. A sweep failure must not prevent
 * a worker from starting or take down a running one — a full disk is a
 * degradation, an unstartable worker is an outage. Every per-entry error is
 * reported through `onError` and counted in `failed`; the next sweep simply
 * tries again.
 *
 * Both the clock and the filesystem are injected so this is provable
 * without a real disk or a real elapsed wait.
 */
export async function sweepStaleWorkerTempDirs(options: {
  root: string;
  minAgeMs: number;
  now?: number;
  fs?: WorkerTempFs;
  onError?: (message: string) => void;
}): Promise<StaleTempSweepResult> {
  const {
    root,
    minAgeMs,
    now = Date.now(),
    fs = REAL_FS,
    onError = () => undefined,
  } = options;

  const result: StaleTempSweepResult = {
    removed: 0,
    skippedTooYoung: 0,
    failed: 0,
  };

  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (error) {
    onError(`Could not list the worker temp root: ${briefly(error)}`);
    return result;
  }

  for (const entry of entries) {
    if (!entry.startsWith(TRANSCODE_WORKER_TEMP_DIR_PREFIX)) {
      continue;
    }

    const path = join(root, entry);

    try {
      const { mtimeMs } = await fs.stat(path);

      if (now - mtimeMs < minAgeMs) {
        result.skippedTooYoung += 1;
        continue;
      }

      await fs.rm(path);
      result.removed += 1;
    } catch (error) {
      result.failed += 1;
      onError(`Could not remove stale temp directory: ${briefly(error)}`);
    }
  }

  return result;
}

function briefly(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
