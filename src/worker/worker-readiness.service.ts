import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RootConfig } from '../config/configuration';
import { FFMPEG_AVAILABILITY_CLIENT } from '../transcode/hls/hls.types';
import type { FfmpegAvailabilityClient } from '../transcode/hls/hls.types';
import type { WorkerReadinessSummary } from './worker-readiness.types';

/**
 * Slice 11O — computes the worker's boot-time readiness summary: ffmpeg/
 * ffprobe presence (via the injected `FfmpegAvailabilityClient`, so this
 * class's own unit tests never spawn a real process) plus a secret-free
 * config summary. This is the "worker start smoke" the approval requires —
 * `src/worker/main.ts` logs this and exits `0` without ever running FFmpeg
 * or touching a `Video`/catalog row.
 */
@Injectable()
export class WorkerReadinessService {
  constructor(
    @Inject(FFMPEG_AVAILABILITY_CLIENT)
    private readonly ffmpegAvailabilityClient: FfmpegAvailabilityClient,
    private readonly configService: ConfigService<RootConfig>,
  ) {}

  async check(): Promise<WorkerReadinessSummary> {
    const availability = await this.ffmpegAvailabilityClient.check();
    const storageConfig = this.configService.get('storage', { infer: true })!;
    const transcodeConfig = this.configService.get('transcode', {
      infer: true,
    })!;

    return {
      ffmpegAvailable: availability.ffmpegAvailable,
      ffprobeAvailable: availability.ffprobeAvailable,
      ffmpegVersion: availability.ffmpegVersion,
      ffprobeVersion: availability.ffprobeVersion,
      config: {
        nodeEnv: process.env.NODE_ENV,
        storageDriver: storageConfig.driver,
        transcodeEnabled: transcodeConfig.enabled,
      },
    };
  }
}
