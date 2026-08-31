import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from '../../config/configuration';
import { validateEnv } from '../../config/env.validation';
import { PrismaModule } from '../../prisma/prisma.module';
import { LocalCoverIngestService } from './local-cover-ingest.service';

/**
 * Work unit "LOCAL SERIES COVER ARTWORK": the minimal standalone Nest context
 * the cover-ingest CLI boots, following the `R2MediaMigrationCliModule` /
 * `SeriesCoverOrphanCliModule` / `WorkerModule` precedent.
 *
 * No `StorageModule`, unlike its R2 sibling: this tool writes to the LOCAL
 * filesystem object root and never constructs or reaches an S3 client. Not
 * importing it is what makes "this CLI cannot touch a bucket" a structural
 * fact rather than a claim in a comment.
 *
 * Deliberately NOT imported by `AppModule`. `LocalCoverIngestService` is
 * reachable from no HTTP route, no cron registration and no application boot
 * path; this module exists solely so an operator running the CLI by hand can
 * resolve it. `validateEnv` still runs, so a misconfigured environment fails
 * loudly at boot exactly as it does for the server.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    PrismaModule,
  ],
  providers: [LocalCoverIngestService],
})
export class LocalCoverIngestCliModule {}
