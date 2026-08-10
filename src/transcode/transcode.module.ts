import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RootConfig } from '../config/configuration';
import { StorageModule } from '../storage/storage.module';
import { ThumbnailsModule } from '../thumbnails/thumbnails.module';
import { BullmqTranscodeQueueClient } from './bullmq-transcode-queue.client';
import { HlsModule } from './hls/hls.module';
import { NoopTranscodeQueueClient } from './noop-transcode-queue.client';
import { TranscodeIntentService } from './transcode-intent.service';
import { TranscodeJanitorService } from './transcode-janitor.service';
import { TranscodeJobProcessor } from './transcode-job-processor.service';
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
 *
 * Slice 11P additionally imports `StorageModule` (for `StorageService`),
 * `HlsModule` (the Slice 11O FFmpeg/HLS pipeline primitives —
 * `HLS_PROBE_CLIENT`, `HlsTranscodeService`, `MasterPlaylistService`,
 * `HlsPackageValidator`), and `ThumbnailsModule` (for the raw
 * `THUMBNAIL_CLIENT` — see `TranscodeJobProcessor`'s doc comment for why the
 * raw client, not `ThumbnailService`, is what the poster step uses), and
 * registers `TranscodeJobProcessor`/`TranscodeJanitorService`. These new
 * providers are constructed wherever `TranscodeModule` is imported
 * (currently `MediaModule`, for the HTTP app, and `WorkerModule` — see that
 * module's doc comment) — registering a provider costs nothing until a
 * caller actually invokes it, and NOTHING in the HTTP app's request path
 * ever calls `TranscodeJobProcessor.process`/`TranscodeJanitorService`'s
 * methods; only the worker entry's flag-gated persistent mode does.
 */
@Module({
  imports: [StorageModule, HlsModule, ThumbnailsModule],
  providers: [
    TranscodeIntentService,
    TranscodeReconcilerService,
    TranscodeJobProcessor,
    TranscodeJanitorService,
    {
      provide: TRANSCODE_QUEUE,
      useFactory: (
        configService: ConfigService<RootConfig>,
      ): TranscodeQueue => {
        const transcodeConfig = configService.get('transcode', {
          infer: true,
        })!;

        return transcodeConfig.enabled
          ? new BullmqTranscodeQueueClient(
              transcodeConfig.redisUrl!,
              transcodeConfig.maxAttempts,
            )
          : new NoopTranscodeQueueClient();
      },
      inject: [ConfigService],
    },
  ],
  exports: [
    TranscodeIntentService,
    TranscodeReconcilerService,
    TranscodeJobProcessor,
    TranscodeJanitorService,
    TRANSCODE_QUEUE,
  ],
})
export class TranscodeModule {}
