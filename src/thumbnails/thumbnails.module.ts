import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { FfmpegThumbnailCliClient } from './ffmpeg-thumbnail-cli.client';
import { ThumbnailService } from './thumbnail.service';
import { THUMBNAIL_CLIENT } from './thumbnail.types';

/**
 * Phase 11, work units 11D-2a/11D-2b. Not imported into `AppModule` in this
 * slice: there is no HTTP controller/route yet (mirrors `ImporterModule`'s
 * precedent) — wiring a real upload/ingestion surface into the public/admin
 * API is the separate, human-supervised `11D-2-real` step. Imports
 * `StorageModule` so `ThumbnailService` can inject the real `StorageService`
 * (mocked in every unit test in this slice); exports `ThumbnailService` so a
 * future importer/admin route can invoke it without duplicating this
 * wiring.
 */
@Module({
  imports: [StorageModule],
  providers: [
    ThumbnailService,
    { provide: THUMBNAIL_CLIENT, useClass: FfmpegThumbnailCliClient },
  ],
  exports: [ThumbnailService],
})
export class ThumbnailsModule {}
