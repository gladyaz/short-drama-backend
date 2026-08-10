import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TranscodeConfig } from '../config/configuration';
import { PrismaModule } from '../prisma/prisma.module';
import { NoopTranscodeQueueClient } from './noop-transcode-queue.client';
import { TranscodeModule } from './transcode.module';
import { TRANSCODE_QUEUE } from './transcode.types';
import type { TranscodeQueue } from './transcode.types';

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
    transcodeConfig: TranscodeConfig,
  ): Promise<TestingModule> {
    return Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ transcode: transcodeConfig })],
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
