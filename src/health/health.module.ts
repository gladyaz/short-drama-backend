import { Module } from '@nestjs/common';
import { DevToolsGuard } from '../entitlements/guards/dev-tools.guard';
import { HealthController } from './health.controller';
import { StorageReadinessService } from './storage-readiness.service';

/**
 * `DevToolsGuard` is provided here directly (Phase 11, work unit 11-B5)
 * rather than exported from `EntitlementsModule` — the guard's only
 * dependency is the global `ConfigService`, so providing the class locally
 * is simpler than widening another module's export surface.
 * `PrismaService` comes from the global `PrismaModule`.
 *
 * `StorageReadinessService` (Phase 11, work unit 11G-4) is likewise provided
 * locally — its only dependency is the global `ConfigService`, and nothing
 * outside `HealthController` needs it.
 */
@Module({
  controllers: [HealthController],
  providers: [DevToolsGuard, StorageReadinessService],
})
export class HealthModule {}
