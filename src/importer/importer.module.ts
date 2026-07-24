import { Module } from '@nestjs/common';
import { FfprobeCliClient } from './ffprobe-cli.client';
import { FFPROBE_CLIENT } from './importer.types';
import { MediaImporterService } from './media-importer.service';

/**
 * Phase 11, work unit 11D-1. Not imported into `AppModule` in this slice:
 * there is no HTTP route (the task/runbook scopes 11D-1 to the importer
 * service + fixtures-only unit tests, no controller/e2e), and running it
 * for real against the company library is the separate, human-supervised
 * `11D-1-real` step. `MediaImporterService` is exported so a future admin
 * route or CLI script can invoke it without duplicating this wiring.
 */
@Module({
  providers: [
    MediaImporterService,
    { provide: FFPROBE_CLIENT, useClass: FfprobeCliClient },
  ],
  exports: [MediaImporterService],
})
export class ImporterModule {}
