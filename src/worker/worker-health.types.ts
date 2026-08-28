/**
 * VPS DEPLOYMENT (work unit "TRANSCODE WORKER VPS DEPLOYMENT") — the
 * worker's health/readiness report shape.
 *
 * SECRET-FREE BY CONSTRUCTION, mirroring `WorkerReadinessSummary`'s existing
 * rule: every field is a boolean, a number, an enum-like string, or a short
 * diagnostic message this module writes itself. No field ever carries
 * `REDIS_URL`, an R2 credential, or a signed URL — the Redis check reports
 * `reachable` plus a latency, never the URL it dialled.
 */
export type WorkerHealthCheckName =
  'process' | 'config' | 'ffmpeg' | 'ffprobe' | 'redis';

export interface WorkerHealthCheck {
  name: WorkerHealthCheckName;
  ok: boolean;
  /** Short, secret-free explanation. Present on failure; optional on success. */
  detail?: string;
  /** Round-trip milliseconds, for checks that dial something. */
  latencyMs?: number;
}

export interface WorkerHealthReport {
  healthy: boolean;
  checks: WorkerHealthCheck[];
}
