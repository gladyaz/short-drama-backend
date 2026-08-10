import { Injectable } from '@nestjs/common';
import { TranscodeJobPayload, TranscodeQueue } from './transcode.types';

/**
 * Slice 11N: the inert default queue client. `TranscodeModule` provides this
 * (never `BullmqTranscodeQueueClient`) whenever `TRANSCODE_ENABLED` is not
 * exactly `"true"` — which is every real deployment this slice ships,
 * `TRANSCODE_ENABLED=false` being the hard default (2026-08-10 DECISIONS.md
 * approval). `add` resolves immediately and touches nothing — no Redis
 * client is ever constructed, so a Redis outage (or Redis never having been
 * installed at all) is completely harmless while the flag is off.
 *
 * In normal operation this is never actually called: the only call site,
 * `AdminMediaService.completeUpload`, guards the call to
 * `TranscodeIntentService.requestProcessing` behind the SAME
 * `TRANSCODE_ENABLED` check, so `TranscodeIntentService` (and therefore this
 * client) is never reached while the flag is off. It exists so the
 * `TRANSCODE_QUEUE` DI token always resolves to a real object (never
 * `undefined`) regardless of flag state, keeping `TranscodeIntentService`/
 * `TranscodeReconcilerService`'s own constructors simple.
 */
@Injectable()
export class NoopTranscodeQueueClient implements TranscodeQueue {
  async add(jobId: string, payload: TranscodeJobPayload): Promise<void> {
    void jobId;
    void payload;
    return Promise.resolve();
  }
}
