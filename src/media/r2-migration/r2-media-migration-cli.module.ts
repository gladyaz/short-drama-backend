import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from '../../config/configuration';
import { validateEnv } from '../../config/env.validation';
import { PrismaModule } from '../../prisma/prisma.module';
import { StorageModule } from '../../storage/storage.module';
import { R2MediaMigrationService } from './r2-media-migration.service';

/**
 * Work unit "R2 MEDIA MIGRATION": the minimal standalone Nest context the
 * migration CLI boots, following the `SeriesCoverOrphanCliModule` /
 * `WorkerModule` precedent already established in this repo.
 *
 * It imports `StorageModule` rather than constructing an `S3Client` of its
 * own, so the CLI necessarily talks to storage through the EXACT same client
 * factory (endpoint, region, `forcePathStyle`, credentials) the HTTP app
 * uses. A second hand-rolled client here would be free to drift — and a
 * migration that wrote to a subtly different endpoint than the one serving
 * playback is the worst possible thing for this tool to get wrong.
 *
 * Deliberately NOT imported by `AppModule`. `R2MediaMigrationService` is
 * reachable from no HTTP route, no cron registration, and no application
 * boot path; this module exists solely so an operator running the CLI by
 * hand can resolve it. `validateEnv` still runs, so a misconfigured
 * environment fails loudly at boot exactly as it does for the server.
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
  providers: [R2MediaMigrationService],
})
export class R2MediaMigrationCliModule {}
