import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TranscodeConfig } from '../config/configuration';
import { TranscodeReadinessService } from './transcode-readiness.service';

/**
 * Slice 11P: this file only ever exercises `enabled`/`redisUrl` (the only
 * two fields `TranscodeReadinessService` reads) — `Partial<TranscodeConfig>`
 * plus these fixed defaults for the three 11P-added tunables keeps every
 * existing call site below unchanged.
 */
async function buildService(
  transcodeConfig: Partial<TranscodeConfig> &
    Pick<TranscodeConfig, 'enabled' | 'redisUrl'>,
): Promise<TranscodeReadinessService> {
  const fullConfig: TranscodeConfig = {
    maxAttempts: 3,
    stalledAfterMinutes: 30,
    cleanupGraceMinutes: 120,
    workerConcurrency: 1,
    tempDir: undefined,
    tempSweepMinAgeMinutes: 120,
    ...transcodeConfig,
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      TranscodeReadinessService,
      {
        provide: ConfigService,
        useValue: { get: () => fullConfig },
      },
    ],
  }).compile();

  return module.get<TranscodeReadinessService>(TranscodeReadinessService);
}

/**
 * Slice 11N, proof 11 (secret-free health output) plus the readiness-shape
 * requirements from the 2026-08-10 DECISIONS.md approval, item 7:
 * "flag off ⇒ transcode readiness NOT required for app readiness; flag on
 * ⇒ queue config readiness becomes relevant." Never makes a network call —
 * `ConfigService` is entirely mocked, and `TranscodeReadinessService` itself
 * has no dependency capable of opening a Redis connection.
 */
describe('TranscodeReadinessService', () => {
  it('reports only { enabled: false } when the flag is off — no configPresent/ready keys at all', async () => {
    const service = await buildService({ enabled: false, redisUrl: undefined });

    const response = service.check();

    expect(response).toEqual({ enabled: false });
    expect(Object.keys(response)).toEqual(['enabled']);
  });

  it('reports enabled/configPresent/ready all true when the flag is on and REDIS_URL is configured', async () => {
    const service = await buildService({
      enabled: true,
      redisUrl: 'redis://localhost:6379',
    });

    expect(service.check()).toEqual({
      enabled: true,
      configPresent: true,
      ready: true,
    });
  });

  it.each([
    ['undefined (unset)', undefined],
    ['an empty string', ''],
    ['a whitespace-only string', '   '],
  ])(
    'reports configPresent/ready false when the flag is on but REDIS_URL is %s',
    async (_label, redisUrl) => {
      const service = await buildService({ enabled: true, redisUrl });

      expect(service.check()).toEqual({
        enabled: true,
        configPresent: false,
        ready: false,
      });
    },
  );

  it('never leaks the REDIS_URL value — response contains no "redis://", password, or host substring', async () => {
    const sentinelUrl =
      'redis://user:S3NT1NEL-11N-DO-NOT-LEAK-p4ssw0rd@my-real-redis-host.internal:6379';
    const service = await buildService({
      enabled: true,
      redisUrl: sentinelUrl,
    });

    const serialized = JSON.stringify(service.check());

    expect(serialized).not.toContain('redis://');
    expect(serialized).not.toContain('S3NT1NEL-11N-DO-NOT-LEAK-p4ssw0rd');
    expect(serialized).not.toContain('my-real-redis-host.internal');
    expect(Object.keys(service.check()).sort()).toEqual([
      'configPresent',
      'enabled',
      'ready',
    ]);
  });
});
