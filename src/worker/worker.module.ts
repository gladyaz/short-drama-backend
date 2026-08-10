import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from '../config/configuration';
import { validateEnv } from '../config/env.validation';
import { PrismaModule } from '../prisma/prisma.module';
import { HlsModule } from '../transcode/hls/hls.module';
import { TranscodeModule } from '../transcode/transcode.module';
import { WorkerReadinessService } from './worker-readiness.service';

/**
 * Slice 11O — the dedicated FFmpeg/HLS worker's NestJS module (proposal §1:
 * "A dedicated FFmpeg worker process ... second entry point
 * (`src/worker/main.ts`, NestJS standalone application context) sharing
 * ... config"). Booted via `NestFactory.createApplicationContext` in
 * `main.ts` — there is NO HTTP listener anywhere in this module or its
 * dependency graph, and FFmpeg never runs inside `AppModule`'s HTTP request
 * path (approval binding constraint 2).
 *
 * Reuses the SAME `configuration()`/`validateEnv()` pair `AppModule` uses
 * (`ConfigModule.forRoot` here is a fresh instance, since this is a
 * separate application context with its own DI container — not literally
 * the same `ConfigModule` instance as the HTTP app) rather than inventing a
 * worker-specific env schema, so there is exactly one source of truth for
 * what this repo's environment variables mean. This also keeps the worker
 * "movable to another server without media-model change" (proposal §1):
 * whichever machine runs `node dist/worker/main` just needs the same `.env`
 * shape the API server already requires.
 *
 * Slice 11O: deliberately did NOT import `PrismaModule` — nothing in that
 * slice's `HlsModule` reads or writes a `Video`/catalog row, so the worker's
 * boot smoke had zero database dependency in the default (`TRANSCODE_ENABLED
 * =false`) smoke-mode path.
 *
 * Slice 11P amendment (fix cycle 1, corrects an earlier version of this
 * comment that was WRONG): `TranscodeJobProcessor`/`TranscodeJanitorService`
 * (both provided by `TranscodeModule`) genuinely need `PrismaService` to
 * consume real jobs in the flag-on persistent-worker mode
 * (`src/worker/main.ts`'s `bootstrapWorker`), but unconditionally importing
 * `PrismaModule`/`TranscodeModule` here DID regress the Slice 11O smoke-mode
 * boot guarantee — `PrismaService.onModuleInit` runs for EVERY module Nest
 * initializes via `NestFactory.createApplicationContext`, regardless of
 * `TRANSCODE_ENABLED`, so a static `@Module` import made `$connect()` fire
 * (and therefore made the worker crash on an unreachable `DATABASE_URL`)
 * even in the default, `TRANSCODE_ENABLED=false` smoke-mode path. The
 * earlier version of this comment claiming that guarantee was preserved was
 * incorrect.
 *
 * The actual fix: `WorkerModule` is now a DYNAMIC module. `register()` reads
 * `process.env.TRANSCODE_ENABLED` directly — the same `=== 'true'` check
 * `configuration.ts` uses — BEFORE the `imports` array is built, and only
 * includes `PrismaModule`/`TranscodeModule` in that array when the flag is
 * on. This has to happen synchronously at registration time (not via
 * `ConfigService`, which is itself a provider that only exists once the
 * module graph this decision controls has already been assembled).
 * Consequence: with `TRANSCODE_ENABLED=false` (this repo's only shipped
 * default), `PrismaModule` never enters the module graph at all, so
 * `PrismaService` is never constructed and `$connect()` is never called —
 * `node dist/worker/main` boots and exits `0` with zero database dependency,
 * even when `DATABASE_URL` points at an unreachable host. With
 * `TRANSCODE_ENABLED=true`, `PrismaModule`/`TranscodeModule` are imported
 * exactly as before, so `TranscodeJobProcessor`/`TranscodeJanitorService`
 * still receive `PrismaService` through DI (global scoping applies per
 * module tree, not process-wide, so importing the `@Global()` `PrismaModule`
 * here — a separate application-context root from the HTTP `AppModule` —
 * is still what makes that possible).
 */
@Module({})
export class WorkerModule {
  static register(): DynamicModule {
    const transcodeEnabled = process.env.TRANSCODE_ENABLED === 'true';

    return {
      module: WorkerModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [configuration],
          validate: validateEnv,
        }),
        HlsModule,
        ...(transcodeEnabled ? [PrismaModule, TranscodeModule] : []),
      ],
      providers: [WorkerReadinessService],
      exports: [WorkerReadinessService],
    };
  }
}
