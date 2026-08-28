import { WorkerHealthCheck, WorkerHealthReport } from './worker-health.types';

/**
 * VPS DEPLOYMENT (work unit "TRANSCODE WORKER VPS DEPLOYMENT") — the
 * worker's health check, as a pure function over injected probes.
 *
 * WHY A COMMAND AND NOT AN HTTP ENDPOINT. This process is a queue consumer
 * with no listener of its own (`NestFactory.createApplicationContext`, no
 * `app.listen()` anywhere — Slice 11O approval, binding constraint 2).
 * Adding an HTTP server purely to answer a health probe would put a network
 * listener on a box whose whole security posture is "it dials out, nothing
 * dials in". A command that exits `0`/`1` is what Docker's `HEALTHCHECK`
 * and systemd's `ExecStartPre` both consume natively, so it costs nothing
 * and opens no port.
 *
 * WHAT IT PROVES, and why exactly these:
 *
 * - **process** — trivially true if this code runs at all. Kept as an
 *   explicit check so a report is never ambiguous about what it covered.
 * - **config** — the shared `validateEnv` accepted this environment. Catches
 *   the single most common unattended-deploy failure (a missing or
 *   malformed variable) BEFORE it becomes a crash loop.
 * - **ffmpeg / ffprobe** — both binaries resolve and report a version. A
 *   worker without them consumes jobs and fails every one of them, which
 *   looks like a media problem and is not.
 * - **redis** — an actual `PING` round-trip, not a URL shape check. This is
 *   the only check that proves the queue is genuinely reachable from THIS
 *   box, which is precisely what a fresh VPS's firewall or a wrong bind
 *   address gets wrong.
 *
 * The database is DELIBERATELY not probed. It is a real dependency of a
 * running worker, but a Postgres blip would then flap this command and make
 * an orchestrator restart a worker whose queue and encoder are both fine —
 * and restarting mid-encode is the expensive failure. DB reachability
 * surfaces as job failures with durable error codes, which is the right
 * place for it.
 */

export interface WorkerHealthProbes {
  /** Runs the shared `validateEnv`; resolves on success, throws/rejects on invalid config. */
  checkConfig: () => Promise<void>;
  checkFfmpeg: () => Promise<{
    ffmpegAvailable: boolean;
    ffprobeAvailable: boolean;
    ffmpegVersion?: string;
    ffprobeVersion?: string;
  }>;
  /** Resolves when a Redis `PING` round-trips; rejects otherwise. */
  pingRedis: () => Promise<void>;
  /** Whether Redis is expected to be configured at all (`TRANSCODE_ENABLED`). */
  transcodeEnabled: boolean;
  /** Present iff `REDIS_URL` is set. The VALUE is never read here — presence only. */
  redisConfigured: boolean;
  now?: () => number;
}

export async function checkWorkerHealth(
  probes: WorkerHealthProbes,
): Promise<WorkerHealthReport> {
  const now = probes.now ?? Date.now;
  const checks: WorkerHealthCheck[] = [{ name: 'process', ok: true }];

  try {
    await probes.checkConfig();
    checks.push({ name: 'config', ok: true });
  } catch (error) {
    checks.push({
      name: 'config',
      ok: false,
      // `validateEnv`'s messages name the offending VARIABLE and never echo
      // its value — that is a documented invariant of every validator in
      // `env.validation.ts`, which is why this message is safe to surface.
      detail: brief(error),
    });
  }

  try {
    const availability = await probes.checkFfmpeg();
    checks.push({
      name: 'ffmpeg',
      ok: availability.ffmpegAvailable,
      detail: availability.ffmpegAvailable
        ? availability.ffmpegVersion
        : 'ffmpeg is not installed or not on PATH.',
    });
    checks.push({
      name: 'ffprobe',
      ok: availability.ffprobeAvailable,
      detail: availability.ffprobeAvailable
        ? availability.ffprobeVersion
        : 'ffprobe is not installed or not on PATH.',
    });
  } catch (error) {
    const detail = `Could not probe the FFmpeg binaries: ${brief(error)}`;
    checks.push({ name: 'ffmpeg', ok: false, detail });
    checks.push({ name: 'ffprobe', ok: false, detail });
  }

  checks.push(await redisCheck(probes, now));

  return { healthy: checks.every((check) => check.ok), checks };
}

async function redisCheck(
  probes: WorkerHealthProbes,
  now: () => number,
): Promise<WorkerHealthCheck> {
  // With TRANSCODE_ENABLED=false the worker boots, logs its readiness
  // summary and exits 0 by design — it never opens a Redis connection, so
  // an unreachable (or absent) Redis is not a fault. Reporting `ok` with an
  // explicit reason keeps `TRANSCODE_ENABLED=false` from looking broken,
  // while still making it obvious from the report why nothing was dialled.
  if (!probes.transcodeEnabled) {
    return {
      name: 'redis',
      ok: true,
      detail: 'Skipped — TRANSCODE_ENABLED is not "true", so no queue is used.',
    };
  }

  if (!probes.redisConfigured) {
    return {
      name: 'redis',
      ok: false,
      detail:
        'REDIS_URL is not set, but TRANSCODE_ENABLED=true requires it (see .env.example).',
    };
  }

  const startedAt = now();
  try {
    await probes.pingRedis();
    return { name: 'redis', ok: true, latencyMs: now() - startedAt };
  } catch (error) {
    return {
      name: 'redis',
      ok: false,
      latencyMs: now() - startedAt,
      detail: `Redis PING failed: ${brief(error)}`,
    };
  }
}

function brief(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
