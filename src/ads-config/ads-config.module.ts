import { Module } from '@nestjs/common';
import { AdsConfigController } from './ads-config.controller';
import { AdsConfigService } from './ads-config.service';

/**
 * Phase 15A, slice 15A-S1. `AdsConfigService`'s only dependency is
 * `process.env` (read directly, once, in its constructor — see the
 * service's own doc comment), so — like `HealthModule`'s
 * `StorageReadinessService` — this module needs no `imports:` at all.
 */
@Module({
  controllers: [AdsConfigController],
  providers: [AdsConfigService],
})
export class AdsConfigModule {}
