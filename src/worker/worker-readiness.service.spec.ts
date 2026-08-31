import { ConfigService } from '@nestjs/config';
import { RootConfig } from '../config/configuration';
import { FfmpegAvailabilityClient } from '../transcode/hls/hls.types';
import { WorkerReadinessService } from './worker-readiness.service';

function buildConfigService(
  overrides: Partial<RootConfig> = {},
): ConfigService<RootConfig> {
  const config: Partial<RootConfig> = {
    storage: {
      driver: 'r2',
      endpoint: 'https://mock.example.test',
      region: 'auto',
      bucket: 'mock-bucket',
      accessKeyId: 'mock-secret-should-never-be-logged',
      secretAccessKey: 'mock-secret-should-never-be-logged',
      publicBaseUrl: undefined,
      localRoot: '/tmp/local-objects.test',
    },
    transcode: {
      enabled: false,
      redisUrl: undefined,
      maxAttempts: 3,
      stalledAfterMinutes: 30,
      cleanupGraceMinutes: 120,
      workerConcurrency: 1,
      tempDir: undefined,
      tempSweepMinAgeMinutes: 120,
    },
    ...overrides,
  };

  return {
    get: (key: string) => (config as Record<string, unknown>)[key],
  } as unknown as ConfigService<RootConfig>;
}

describe('WorkerReadinessService', () => {
  it('reports ffmpeg/ffprobe availability from the injected client', async () => {
    const client: jest.Mocked<FfmpegAvailabilityClient> = {
      check: jest.fn().mockResolvedValue({
        ffmpegAvailable: true,
        ffprobeAvailable: true,
        ffmpegVersion: '8.1.2',
        ffprobeVersion: '8.1.2',
      }),
    };
    const service = new WorkerReadinessService(client, buildConfigService());

    const summary = await service.check();

    expect(summary.ffmpegAvailable).toBe(true);
    expect(summary.ffprobeAvailable).toBe(true);
    expect(summary.ffmpegVersion).toBe('8.1.2');
  });

  it('reports unavailable ffmpeg without throwing', async () => {
    const client: jest.Mocked<FfmpegAvailabilityClient> = {
      check: jest.fn().mockResolvedValue({
        ffmpegAvailable: false,
        ffprobeAvailable: false,
      }),
    };
    const service = new WorkerReadinessService(client, buildConfigService());

    const summary = await service.check();

    expect(summary.ffmpegAvailable).toBe(false);
    expect(summary.ffprobeAvailable).toBe(false);
  });

  it('includes a secret-free config summary (booleans/enum strings only)', async () => {
    const client: jest.Mocked<FfmpegAvailabilityClient> = {
      check: jest
        .fn()
        .mockResolvedValue({ ffmpegAvailable: true, ffprobeAvailable: true }),
    };
    const service = new WorkerReadinessService(
      client,
      buildConfigService({
        transcode: {
          enabled: true,
          redisUrl: 'redis://secret-should-not-appear:6379',
          maxAttempts: 3,
          stalledAfterMinutes: 30,
          cleanupGraceMinutes: 120,
          workerConcurrency: 1,
          tempDir: undefined,
          tempSweepMinAgeMinutes: 120,
        },
      }),
    );

    const summary = await service.check();

    expect(summary.config.storageDriver).toBe('r2');
    expect(summary.config.transcodeEnabled).toBe(true);
    expect(JSON.stringify(summary)).not.toContain('secret-should-not-appear');
    expect(JSON.stringify(summary)).not.toContain(
      'mock-secret-should-never-be-logged',
    );
  });

  it('never calls anything on ConfigService besides storage/transcode keys', async () => {
    const client: jest.Mocked<FfmpegAvailabilityClient> = {
      check: jest
        .fn()
        .mockResolvedValue({ ffmpegAvailable: true, ffprobeAvailable: true }),
    };
    const configService = buildConfigService();
    const getSpy = jest.spyOn(configService, 'get');
    const service = new WorkerReadinessService(client, configService);

    await service.check();

    const calledKeys = getSpy.mock.calls.map((call) => call[0]);
    expect(calledKeys).toEqual(
      expect.arrayContaining(['storage', 'transcode']),
    );
  });
});
