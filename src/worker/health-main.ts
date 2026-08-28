import IORedis from 'ioredis';
import { redactSensitiveText } from '../common/logging/redact';
import { validateEnv } from '../config/env.validation';
import { FfmpegAvailabilityCliClient } from '../transcode/hls/ffmpeg-availability-cli.client';
import { checkWorkerHealth } from './worker-health';
import { WorkerHealthReport } from './worker-health.types';

/**
 * VPS DEPLOYMENT (work unit "TRANSCODE WORKER VPS DEPLOYMENT") — the
 * `npm run worker:health` entry point: `node dist/worker/health-main`.
 *
 * A COMPILED entry point under `src/`, deliberately NOT a `ts-node` script
 * under `scripts/` like this repo's other operational commands. Every one of
 * those requires `ts-node` and `dotenv`, which are `devDependencies` and are
 * therefore absent from the production image (`npm ci --omit=dev`). A health
 * command that cannot run inside the very container it grades would be
 * useless as a `HEALTHCHECK`, so this one compiles into `dist/` alongside
 * the worker itself and depends only on runtime dependencies.
 *
 * Prints ONE redacted JSON report to stdout and exits `0` (healthy) or `1`
 * (unhealthy) — the contract Docker's `HEALTHCHECK` and systemd's
 * `ExecStartPre` both consume directly.
 *
 * Grades the AMBIENT environment, with a best-effort `.env` load that
 * mirrors what the worker itself sees: `ConfigModule.forRoot` (a runtime
 * dependency of the worker) reads `.env` when one is present, so a health
 * check that ignored it would grade a different configuration than the
 * process it is meant to describe. In a container there is no `.env` and
 * `dotenv` is not installed — both are non-events, because the container's
 * environment is authoritative there.
 */
export async function runWorkerHealthCommand(
  emit: (line: string) => void = console.log,
): Promise<WorkerHealthReport> {
  loadDotenvIfAvailable();

  const transcodeEnabled = process.env.TRANSCODE_ENABLED === 'true';
  const redisUrl = process.env.REDIS_URL;
  const availabilityClient = new FfmpegAvailabilityCliClient();

  const report = await checkWorkerHealth({
    checkConfig: () => {
      validateEnv(process.env);
      return Promise.resolve();
    },
    checkFfmpeg: () => availabilityClient.check(),
    pingRedis: () => pingRedis(redisUrl!),
    transcodeEnabled,
    redisConfigured: redisUrl !== undefined && redisUrl.trim().length > 0,
  });

  emit(redactSensitiveText(JSON.stringify(report)));

  return report;
}

/**
 * A single, short-lived `PING`.
 *
 * `lazyConnect` plus `maxRetriesPerRequest: 0` and a bounded
 * `connectTimeout` are all load-bearing: ioredis's DEFAULT behavior is to
 * retry a failed connection forever, which would make an unreachable Redis
 * hang this command indefinitely instead of reporting the failure it exists
 * to report. `disconnect()` in a `finally` guarantees the process can exit
 * even when the dial failed halfway.
 */
async function pingRedis(redisUrl: string): Promise<void> {
  const client = new IORedis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    connectTimeout: REDIS_HEALTH_TIMEOUT_MS,
    enableOfflineQueue: false,
  });

  // ioredis emits `error` on a failed dial. With NO listener attached, Node's
  // EventEmitter turns that into an "Unhandled error event" written straight
  // to stderr — which would corrupt this command's contract of emitting
  // exactly one clean JSON line. The rejection from `connect()` below is the
  // real signal and is what the caller reports; this listener exists purely
  // to keep the emitter quiet.
  client.on('error', () => undefined);

  try {
    await client.connect();
    await client.ping();
  } finally {
    client.disconnect();
  }
}

/** How long a health `PING` may take before it is reported as a failure. */
const REDIS_HEALTH_TIMEOUT_MS = 5_000;

function loadDotenvIfAvailable(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('dotenv/config');
  } catch {
    // Expected inside the production image, where `dotenv` is a
    // devDependency that was never installed and the container environment
    // is the only source of configuration. Not a failure.
  }
}

if (require.main === module) {
  runWorkerHealthCommand()
    .then((report) => process.exit(report.healthy ? 0 : 1))
    .catch((error: unknown) => {
      console.error(
        redactSensitiveText(
          `Worker health check crashed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      process.exit(1);
    });
}
