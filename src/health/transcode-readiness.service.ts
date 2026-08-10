import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RootConfig } from '../config/configuration';
import { TranscodeReadinessResponse } from './transcode-readiness.types';

/**
 * Slice 11N — HLS Processing Data Model + Queue Foundation. Computes the
 * secret-free transcode-readiness payload surfaced on `/health/details`,
 * mirroring `StorageReadinessService`'s exact "config-presence only, never a
 * live probe" design (2026-08-10 DECISIONS.md approval, item 7:
 * "Readiness: flag off ⇒ transcode readiness NOT required for app
 * readiness; flag on ⇒ queue config readiness becomes relevant. No secret,
 * URL, or credential in any health output or log").
 *
 * Deliberately depends ONLY on `ConfigService` — NOT on the `TRANSCODE_QUEUE`
 * DI token or `TranscodeModule` at all. This is the reason this class can
 * never open a real Redis connection from a health check, in tests or in
 * production: it never touches the queue client, only the parsed config
 * (`enabled`/`redisUrl` presence). `enabled: false` (this slice's shipped
 * default) reports ONLY that one field — no `configPresent`/`ready` at all
 * — mirroring `StorageReadinessResponse.publicDeliveryAvailable`'s "absent
 * means not applicable" precedent (work unit 11I-B1) rather than a
 * hard-coded `false`.
 */
@Injectable()
export class TranscodeReadinessService {
  constructor(private readonly configService: ConfigService<RootConfig>) {}

  check(): TranscodeReadinessResponse {
    const transcodeConfig = this.configService.get('transcode', {
      infer: true,
    })!;

    if (!transcodeConfig.enabled) {
      return { enabled: false };
    }

    const configPresent = isConfigured(transcodeConfig.redisUrl);

    return {
      enabled: true,
      configPresent,
      ready: configPresent,
    };
  }
}

/** Presence only — never compares, parses, logs, or returns the value itself. */
function isConfigured(value: string | undefined): boolean {
  return (value ?? '').trim().length > 0;
}
