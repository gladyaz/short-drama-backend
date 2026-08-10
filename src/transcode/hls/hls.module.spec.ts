import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { FfmpegAvailabilityCliClient } from './ffmpeg-availability-cli.client';
import { HlsEncoderCliClient } from './hls-encoder-cli.client';
import { HlsPackageValidator } from './hls-package-validator.service';
import { HlsProbeCliClient } from './hls-probe-cli.client';
import { HlsSmokeRunner } from './hls-smoke-runner.service';
import { HlsSyntheticGeneratorCliClient } from './hls-synthetic-generator-cli.client';
import { HlsTranscodeService } from './hls-transcode.service';
import { HlsModule } from './hls.module';
import {
  FFMPEG_AVAILABILITY_CLIENT,
  HLS_ENCODER_CLIENT,
  HLS_PROBE_CLIENT,
  HLS_SYNTHETIC_GENERATOR_CLIENT,
} from './hls.types';
import { MasterPlaylistService } from './master-playlist.service';
import { SyntheticSourceService } from './synthetic-source.service';

/**
 * Slice 11O — proves `HlsModule`'s DI wiring resolves to the correct
 * concrete classes WITHOUT ever invoking any of them (no `ffmpeg`/`ffprobe`
 * process is spawned merely by constructing these classes — only calling
 * their methods does). `StorageModule`'s `S3Client` factory only
 * SYNCHRONOUSLY constructs a client object from config; it never opens a
 * network connection, so compiling this module is safe with a fully fake
 * storage config.
 */
describe('HlsModule — DI wiring', () => {
  async function buildModule() {
    return Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              storage: {
                driver: 'r2',
                endpoint: 'https://mock.example.test',
                region: 'auto',
                bucket: 'mock-bucket',
                accessKeyId: 'mock-key',
                secretAccessKey: 'mock-secret',
                publicBaseUrl: undefined,
              },
            }),
          ],
        }),
        HlsModule,
      ],
    }).compile();
  }

  it('provides the real CLI-backed clients behind each DI token', async () => {
    const moduleRef = await buildModule();

    expect(moduleRef.get(FFMPEG_AVAILABILITY_CLIENT)).toBeInstanceOf(
      FfmpegAvailabilityCliClient,
    );
    expect(moduleRef.get(HLS_PROBE_CLIENT)).toBeInstanceOf(HlsProbeCliClient);
    expect(moduleRef.get(HLS_SYNTHETIC_GENERATOR_CLIENT)).toBeInstanceOf(
      HlsSyntheticGeneratorCliClient,
    );
    expect(moduleRef.get(HLS_ENCODER_CLIENT)).toBeInstanceOf(
      HlsEncoderCliClient,
    );

    await moduleRef.close();
  });

  it('resolves every service the pipeline needs', async () => {
    const moduleRef = await buildModule();

    expect(moduleRef.get(SyntheticSourceService)).toBeInstanceOf(
      SyntheticSourceService,
    );
    expect(moduleRef.get(HlsTranscodeService)).toBeInstanceOf(
      HlsTranscodeService,
    );
    expect(moduleRef.get(MasterPlaylistService)).toBeInstanceOf(
      MasterPlaylistService,
    );
    expect(moduleRef.get(HlsPackageValidator)).toBeInstanceOf(
      HlsPackageValidator,
    );
    expect(moduleRef.get(HlsSmokeRunner)).toBeInstanceOf(HlsSmokeRunner);

    await moduleRef.close();
  });
});
