import { checkWorkerHealth, WorkerHealthProbes } from './worker-health';
import { WorkerHealthCheckName } from './worker-health.types';

/**
 * VPS DEPLOYMENT — `npm run worker:health` is what a Docker `HEALTHCHECK`,
 * a systemd `ExecStartPre`, and an operator on a fresh box all run to answer
 * "is this worker able to do its job". Every failure mode it claims to
 * detect is proven here.
 */
describe('checkWorkerHealth', () => {
  function buildProbes(
    overrides: Partial<WorkerHealthProbes> = {},
  ): WorkerHealthProbes {
    return {
      checkConfig: () => Promise.resolve(),
      checkFfmpeg: () =>
        Promise.resolve({
          ffmpegAvailable: true,
          ffprobeAvailable: true,
          ffmpegVersion: 'ffmpeg version 6.1.1',
          ffprobeVersion: 'ffprobe version 6.1.1',
        }),
      pingRedis: () => Promise.resolve(),
      transcodeEnabled: true,
      redisConfigured: true,
      ...overrides,
    };
  }

  function checkNamed(
    report: Awaited<ReturnType<typeof checkWorkerHealth>>,
    name: WorkerHealthCheckName,
  ) {
    const check = report.checks.find((c) => c.name === name);
    expect(check).toBeDefined();
    return check!;
  }

  it('is healthy when config validates, both binaries exist, and Redis answers', async () => {
    const report = await checkWorkerHealth(buildProbes());

    expect(report.healthy).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual([
      'process',
      'config',
      'ffmpeg',
      'ffprobe',
      'redis',
    ]);
  });

  // A worker without FFmpeg consumes jobs and fails every one of them, which
  // looks like a media problem and is not. This is the single most likely
  // mistake on a hand-built VPS.
  it('is unhealthy when ffmpeg is missing, and says so without failing anything else', async () => {
    const report = await checkWorkerHealth(
      buildProbes({
        checkFfmpeg: () =>
          Promise.resolve({ ffmpegAvailable: false, ffprobeAvailable: true }),
      }),
    );

    expect(report.healthy).toBe(false);
    expect(checkNamed(report, 'ffmpeg').ok).toBe(false);
    expect(checkNamed(report, 'ffmpeg').detail).toContain('not on PATH');
    expect(checkNamed(report, 'ffprobe').ok).toBe(true);
    expect(checkNamed(report, 'redis').ok).toBe(true);
  });

  it('is unhealthy when ffprobe alone is missing', async () => {
    const report = await checkWorkerHealth(
      buildProbes({
        checkFfmpeg: () =>
          Promise.resolve({ ffmpegAvailable: true, ffprobeAvailable: false }),
      }),
    );

    expect(report.healthy).toBe(false);
    expect(checkNamed(report, 'ffprobe').ok).toBe(false);
  });

  it('marks both binaries unhealthy when the probe itself throws', async () => {
    const report = await checkWorkerHealth(
      buildProbes({
        checkFfmpeg: () => Promise.reject(new Error('spawn ENOENT')),
      }),
    );

    expect(report.healthy).toBe(false);
    expect(checkNamed(report, 'ffmpeg').detail).toContain('spawn ENOENT');
    expect(checkNamed(report, 'ffprobe').detail).toContain('spawn ENOENT');
  });

  // Missing Redis CONFIG, as distinct from unreachable Redis — the two have
  // completely different fixes and must not report identically.
  it('is unhealthy when TRANSCODE_ENABLED=true but REDIS_URL is not set', async () => {
    const report = await checkWorkerHealth(
      buildProbes({ redisConfigured: false }),
    );

    expect(report.healthy).toBe(false);
    expect(checkNamed(report, 'redis').detail).toContain(
      'REDIS_URL is not set',
    );
  });

  it('is unhealthy when Redis is configured but unreachable, and never leaks the URL', async () => {
    const report = await checkWorkerHealth(
      buildProbes({
        pingRedis: () =>
          Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:6379')),
      }),
    );

    expect(report.healthy).toBe(false);
    const redis = checkNamed(report, 'redis');
    expect(redis.detail).toContain('Redis PING failed');
    expect(JSON.stringify(report)).not.toContain('redis://');
  });

  // With the flag off the worker never opens a Redis connection at all, so
  // an absent Redis is not a fault — reporting it as one would make the
  // repo's shipped default look permanently broken.
  it('skips the Redis check (reporting ok, with a reason) when TRANSCODE_ENABLED is not true', async () => {
    let pinged = false;
    const report = await checkWorkerHealth(
      buildProbes({
        transcodeEnabled: false,
        redisConfigured: false,
        pingRedis: () => {
          pinged = true;
          return Promise.resolve();
        },
      }),
    );

    expect(report.healthy).toBe(true);
    expect(pinged).toBe(false);
    expect(checkNamed(report, 'redis').detail).toContain('Skipped');
  });

  it('is unhealthy when the shared env validation rejects the environment', async () => {
    const report = await checkWorkerHealth(
      buildProbes({
        checkConfig: () =>
          Promise.reject(
            new Error('Missing required environment variable: REDIS_URL.'),
          ),
      }),
    );

    expect(report.healthy).toBe(false);
    expect(checkNamed(report, 'config').detail).toContain('REDIS_URL');
  });

  it('records the Redis round-trip latency', async () => {
    let clock = 1_000;
    const report = await checkWorkerHealth(
      buildProbes({
        now: () => clock,
        pingRedis: () => {
          clock += 42;
          return Promise.resolve();
        },
      }),
    );

    expect(checkNamed(report, 'redis').latencyMs).toBe(42);
  });
});
