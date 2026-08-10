import { Module } from '@nestjs/common';
import { StorageModule } from '../../storage/storage.module';
import { FfmpegAvailabilityCliClient } from './ffmpeg-availability-cli.client';
import { HlsEncoderCliClient } from './hls-encoder-cli.client';
import { HlsPackageValidator } from './hls-package-validator.service';
import { HlsProbeCliClient } from './hls-probe-cli.client';
import { HlsSmokeRunner } from './hls-smoke-runner.service';
import { HlsSyntheticGeneratorCliClient } from './hls-synthetic-generator-cli.client';
import { HlsTranscodeService } from './hls-transcode.service';
import {
  FFMPEG_AVAILABILITY_CLIENT,
  HLS_ENCODER_CLIENT,
  HLS_PROBE_CLIENT,
  HLS_SYNTHETIC_GENERATOR_CLIENT,
} from './hls.types';
import { MasterPlaylistService } from './master-playlist.service';
import { SyntheticSourceService } from './synthetic-source.service';

/**
 * Slice 11O — the local (never-network-by-default) HLS transcode proof
 * pipeline. Every real ffmpeg/ffprobe-shelling class is wired here behind a
 * DI token, mirroring `../../thumbnails/thumbnails.module.ts` /
 * `../../importer/importer.module.ts`'s injectable-CLI-client precedent.
 *
 * Imports `StorageModule` ONLY so `HlsSmokeRunner` can perform the gated
 * upload/verify/cleanup phase — `StorageService` is never called on the
 * default (`options.upload` unset) path. This module deliberately imports
 * NEITHER `PrismaModule` NOR `TranscodeModule`/the `TRANSCODE_QUEUE` token:
 * per the 2026-08-10 approval's binding "DB boundary" constraint, this
 * pipeline takes a local file path and must not read or write any
 * `Video`/catalog row, and per the approval's queue-boundary clause ("a
 * direct gated worker harness is preferred if safer"), this slice proves the
 * worker/transcode architecture via a direct, explicitly-invoked harness
 * (`HlsSmokeRunner.run()`, called from `scripts/hls-local-proof.ts` and the
 * gated real-R2 spec) rather than consuming a job off the 11N BullMQ queue —
 * see the report's "queue boundary" section for the full rationale (no
 * Redis running in this environment, the 11N dedupe/CAS foundation is
 * already independently proven, and wiring BullMQ here would add process
 * lifecycle complexity without adding any proof value for THIS slice's
 * actual subject: does the ffmpeg/HLS pipeline itself work).
 */
@Module({
  imports: [StorageModule],
  providers: [
    {
      provide: FFMPEG_AVAILABILITY_CLIENT,
      useClass: FfmpegAvailabilityCliClient,
    },
    { provide: HLS_PROBE_CLIENT, useClass: HlsProbeCliClient },
    {
      provide: HLS_SYNTHETIC_GENERATOR_CLIENT,
      useClass: HlsSyntheticGeneratorCliClient,
    },
    { provide: HLS_ENCODER_CLIENT, useClass: HlsEncoderCliClient },
    SyntheticSourceService,
    HlsTranscodeService,
    MasterPlaylistService,
    HlsPackageValidator,
    HlsSmokeRunner,
  ],
  exports: [
    FFMPEG_AVAILABILITY_CLIENT,
    HLS_PROBE_CLIENT,
    SyntheticSourceService,
    HlsTranscodeService,
    MasterPlaylistService,
    HlsPackageValidator,
    HlsSmokeRunner,
  ],
})
export class HlsModule {}
