import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { RootConfig, TranscodeConfig } from '../config/configuration';
import { PrismaModule } from '../prisma/prisma.module';
import { NoopTranscodeQueueClient } from './noop-transcode-queue.client';
import { TranscodeModule } from './transcode.module';
import { TRANSCODE_QUEUE } from './transcode.types';
import type { TranscodeQueue } from './transcode.types';

/**
 * Slice 11P: `TranscodeModule` now additionally imports `StorageModule`
 * (for `TranscodeJobProcessor`) — `StorageModule`'s `S3_CLIENT` factory
 * reads `storage` config unconditionally at construction time (it never
 * makes a network call, but it DOES dereference the config object), so this
 * fixture must provide a complete, harmless dummy `storage` block alongside
 * `transcode` or module compilation itself throws before any test body runs.
 */
const DUMMY_STORAGE_CONFIG: RootConfig['storage'] = {
  driver: 'local',
  endpoint: 'https://mock.example.test',
  region: 'auto',
  bucket: 'mock-bucket',
  accessKeyId: 'mock-access-key-id',
  secretAccessKey: 'mock-secret-access-key',
  publicBaseUrl: undefined,
};

/**
 * Slice 11N. Proves the `TRANSCODE_QUEUE` provider's flag gate using
 * `ConfigModule.forRoot({ isGlobal: true, load: [...] })` — the SAME
 * mechanism the real `AppModule` uses (`configuration.ts`) — so
 * `TranscodeModule`'s `inject: [ConfigService]` factory resolves exactly as
 * it does in production, without needing to duplicate/bypass that wiring.
 *
 * Deliberately never exercises `enabled: true` here: doing so would let
 * `TranscodeModule`'s factory construct a real `BullmqTranscodeQueueClient`
 * (and therefore a real `IORedis` client) — see
 * `bullmq-transcode-queue.client.spec.ts` for that class's own, fully
 * mocked (never-connects) coverage instead. This file only proves the
 * flag-OFF branch, which is the only branch any real deployment or test in
 * this repository ever exercises via the real factory.
 */
describe('TranscodeModule — TRANSCODE_QUEUE provider flag gate', () => {
  async function buildModule(
    transcodeConfig: Pick<TranscodeConfig, 'enabled' | 'redisUrl'>,
  ): Promise<TestingModule> {
    const fullConfig: TranscodeConfig = {
      maxAttempts: 3,
      stalledAfterMinutes: 30,
      cleanupGraceMinutes: 120,
      workerConcurrency: 1,
      tempDir: undefined,
      tempSweepMinAgeMinutes: 120,
      ...transcodeConfig,
    };

    return Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({ transcode: fullConfig, storage: DUMMY_STORAGE_CONFIG }),
          ],
        }),
        // TranscodeIntentService/TranscodeReconcilerService (both providers
        // of TranscodeModule) depend on PrismaService, which the real app
        // gets from the @Global() PrismaModule — imported here purely for
        // DI resolution. Module compilation never calls
        // PrismaService.onModuleInit (that only runs via app.init(), never
        // called in this file), so no real database connection is opened.
        PrismaModule,
        TranscodeModule,
      ],
    }).compile();
  }

  it('provides NoopTranscodeQueueClient when TRANSCODE_ENABLED is false — no BullMQ/IORedis object is ever constructed', async () => {
    const module = await buildModule({ enabled: false, redisUrl: undefined });

    const queue = module.get<TranscodeQueue>(TRANSCODE_QUEUE);

    expect(queue).toBeInstanceOf(NoopTranscodeQueueClient);
  });

  it('NoopTranscodeQueueClient.add resolves without touching anything (flag-off invariant)', async () => {
    const module = await buildModule({ enabled: false, redisUrl: undefined });

    const queue = module.get<TranscodeQueue>(TRANSCODE_QUEUE);

    await expect(
      queue.add('some-job-id', { videoId: 'v1', processingVersion: 1 }),
    ).resolves.toBeUndefined();
  });

  it('still provides NoopTranscodeQueueClient even with REDIS_URL entirely absent (Redis-loss/never-installed tolerance)', async () => {
    const module = await buildModule({ enabled: false, redisUrl: undefined });

    expect(module.get<TranscodeQueue>(TRANSCODE_QUEUE)).toBeInstanceOf(
      NoopTranscodeQueueClient,
    );
  });
});
