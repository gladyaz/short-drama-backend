import { Module } from '@nestjs/common';
import { FfprobeCliClient } from './ffprobe-cli.client';
import { FFPROBE_CLIENT } from './importer.types';
import { MediaDryRunService } from './media-dryrun.service';
import { MediaImporterService } from './media-importer.service';

/**
 * Phase 11, work units 11D-1 and 11D-1-dryrun. Not imported into
 * `AppModule` in this slice: there is no HTTP route for either service (the
 * task/runbook scopes both to fixtures-only unit tests, no controller/e2e),
 * and running the real importer against the company library is the
 * separate, human-supervised `11D-1-real` step. `MediaDryRunService` is
 * strictly read-only and has no `PrismaService` dependency at all — see its
 * own doc comment. Both services are exported so a future admin route or
 * CLI script can invoke them without duplicating this wiring.
 */
@Module({
  providers: [
    MediaImporterService,
    MediaDryRunService,
    { provide: FFPROBE_CLIENT, useClass: FfprobeCliClient },
  ],
  exports: [MediaImporterService, MediaDryRunService],
})
export class ImporterModule {}
