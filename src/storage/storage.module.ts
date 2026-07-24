import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import { RootConfig } from '../config/configuration';
import { S3_CLIENT } from './storage.constants';
import { StorageService } from './storage.service';

/**
 * Phase 11, work unit 11A-1. The real `S3Client` is constructed once here,
 * from validated `ConfigService` values, and provided under the `S3_CLIENT`
 * token — `StorageService` never constructs a client itself, which is what
 * lets tests substitute a mocked client with no network access (see
 * `storage.service.spec.ts`). `forcePathStyle: true` matches Cloudflare
 * R2's S3-compatible API requirements (the approved target provider — see
 * DECISIONS.md "Phase 11 (Production Media Storage...) approved..." entry).
 */
@Module({
  providers: [
    {
      provide: S3_CLIENT,
      useFactory: (configService: ConfigService<RootConfig>): S3Client => {
        const storageConfig = configService.get('storage', { infer: true })!;

        return new S3Client({
          region: storageConfig.region,
          endpoint: storageConfig.endpoint || undefined,
          forcePathStyle: true,
          credentials: {
            accessKeyId: storageConfig.accessKeyId,
            secretAccessKey: storageConfig.secretAccessKey,
          },
        });
      },
      inject: [ConfigService],
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
