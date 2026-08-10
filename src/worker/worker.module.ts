import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from '../config/configuration';
import { validateEnv } from '../config/env.validation';
import { HlsModule } from '../transcode/hls/hls.module';
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
 * Deliberately does NOT import `PrismaModule`: nothing in this slice's
 * `HlsModule` reads or writes a `Video`/catalog row (see `HlsModule`'s own
 * doc comment for the full DB-boundary rationale), so the worker's boot
 * smoke has zero database dependency — `node dist/worker/main` can boot and
 * exit `0` even if the database is unreachable, since it never attempts a
 * connection.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    HlsModule,
  ],
  providers: [WorkerReadinessService],
  exports: [WorkerReadinessService],
})
export class WorkerModule {}
