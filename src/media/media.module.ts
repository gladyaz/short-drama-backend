import { Module } from '@nestjs/common';
import { MediaLifecycleService } from './media-lifecycle.service';

/**
 * Phase 11, work unit 11B-1: houses the media lifecycle state machine.
 * `MediaLifecycleService` has no dependencies of its own and exposes no
 * controller yet — the admin-guarded `/admin/media` API that consumes it
 * lands in 11B-3, which extends this module rather than duplicating it.
 * Not yet imported into `AppModule`: nothing outside this module resolves
 * `MediaLifecycleService` until a real route needs it.
 */
@Module({
  providers: [MediaLifecycleService],
  exports: [MediaLifecycleService],
})
export class MediaModule {}
