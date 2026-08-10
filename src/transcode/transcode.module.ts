import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RootConfig } from '../config/configuration';
import { BullmqTranscodeQueueClient } from './bullmq-transcode-queue.client';
import { NoopTranscodeQueueClient } from './noop-transcode-queue.client';
import { TranscodeIntentService } from './transcode-intent.service';
import { TranscodeReconcilerService } from './transcode-reconciler.service';
import { TRANSCODE_QUEUE, TranscodeQueue } from './transcode.types';

/**
 * Slice 11N — HLS Processing Data Model + Queue Foundation.
 *
 * The `TRANSCODE_QUEUE` provider is the flag gate for the ENTIRE module:
 * the factory below constructs a real `BullmqTranscodeQueueClient` (which
 * wraps a BullMQ `Queue` and an `IORedis` client) ONLY when
 * `TRANSCODE_ENABLED` resolved to `true` in `configuration.ts`; every other
 * case — including every real deployment this slice ships, since
 * `TRANSCODE_ENABLED=false` is the hard default (2026-08-10 DECISIONS.md
 * approval) — gets the inert `NoopTranscodeQueueClient`. This is what "the
 * real implementation is constructed LAZILY and only when
 * `TRANSCODE_ENABLED=true`" means in practice: Nest's DI container still
 * calls this factory once at application bootstrap (factory providers are
 * not deferred until first *use*), but WHICH client it builds is entirely
 * flag-gated, so a `BullMQ`/`IORedis` object is never constructed at all
 * while the flag is off — no Redis connection is ever attempted.
 *
 * `env.validation.ts` already guarantees `REDIS_URL` is present (by name)
 * whenever `TRANSCODE_ENABLED=true` reaches this factory — see
 * `validateTranscodeConfig` — so the non-null assertion below is safe: the
 * app fails to boot before this module is ever instantiated if that
 * invariant does not hold.
 *
 * Every test in this slice that needs `TRANSCODE_ENABLED=true` behavior
 * overrides the `TRANSCODE_QUEUE` token directly
 * (`.overrideProvider(TRANSCODE_QUEUE).useValue(mockQueue)`), which replaces
 * this factory entirely — the real `BullmqTranscodeQueueClient` branch is
 * therefore NEVER exercised by any test in this repository, satisfying "no
 * real Redis connection in any test" even for the flag-on test cases.
 */
@Module({
  providers: [
    TranscodeIntentService,
    TranscodeReconcilerService,
    {
      provide: TRANSCODE_QUEUE,
      useFactory: (
        configService: ConfigService<RootConfig>,
      ): TranscodeQueue => {
        const transcodeConfig = configService.get('transcode', {
          infer: true,
        })!;

        return transcodeConfig.enabled
          ? new BullmqTranscodeQueueClient(transcodeConfig.redisUrl!)
          : new NoopTranscodeQueueClient();
      },
      inject: [ConfigService],
    },
  ],
  exports: [
    TranscodeIntentService,
    TranscodeReconcilerService,
    TRANSCODE_QUEUE,
  ],
})
export class TranscodeModule {}
