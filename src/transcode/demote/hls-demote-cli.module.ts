import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from '../../config/configuration';
import { validateEnv } from '../../config/env.validation';
import { PrismaModule } from '../../prisma/prisma.module';
import { StorageModule } from '../../storage/storage.module';
import { HlsDemoteService } from './hls-demote.service';

/**
 * Work unit "HLS DEMOTE": the minimal Nest module the demote CLI boots as a
 * standalone application context, following `SeriesCoverOrphanCliModule`'s
 * established precedent exactly (which itself follows `WorkerModule` +
 * `NestFactory.createApplicationContext`).
 *
 * It imports `StorageModule` rather than constructing an `S3Client` of its
 * own, so the CLI's one read-only `HEAD` goes through the EXACT same client
 * factory the HTTP app uses.
 *
 * Deliberately NOT imported by `AppModule`, and deliberately NOT gated on
 * `TRANSCODE_ENABLED`. `HlsDemoteService` is reachable from no HTTP route,
 * no cron registration and no boot path — but it must stay usable when the
 * transcode feature flag is OFF, because "turn the pipeline off and stop
 * advertising the bad output" is exactly the situation this command exists
 * for. It never touches Redis or the queue, so there is nothing for that
 * flag to protect here.
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
  providers: [HlsDemoteService],
})
export class HlsDemoteCliModule {}
