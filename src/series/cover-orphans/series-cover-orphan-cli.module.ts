import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from '../../config/configuration';
import { validateEnv } from '../../config/env.validation';
import { PrismaModule } from '../../prisma/prisma.module';
import { StorageModule } from '../../storage/storage.module';
import { SeriesCoverOrphanService } from './series-cover-orphan.service';

/**
 * Slice "SERIES COVER ORPHAN CLEANUP LIFECYCLE": the minimal Nest module the
 * maintenance CLI boots as a standalone application context, following the
 * `WorkerModule` + `NestFactory.createApplicationContext` precedent already
 * used by `src/worker/main.ts` and `scripts/hls-local-proof.ts`.
 *
 * It imports `StorageModule` rather than constructing an `S3Client` of its
 * own, so the CLI is guaranteed to talk to storage through the EXACT same
 * client factory (endpoint, region, `forcePathStyle`, credentials) the HTTP
 * app uses — a second, hand-rolled client here would be free to drift.
 *
 * Deliberately NOT imported by `AppModule`. `SeriesCoverOrphanService` is
 * reachable from no HTTP route, no cron registration, and no application
 * boot path; this module exists solely so an operator running the CLI by
 * hand can resolve it. `validateEnv` still runs, so a misconfigured
 * environment fails loudly at boot exactly as it does for the server and the
 * worker.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    PrismaModule,
    StorageModule,
  ],
  providers: [SeriesCoverOrphanService],
})
export class SeriesCoverOrphanCliModule {}
