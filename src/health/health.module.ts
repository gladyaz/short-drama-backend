import { Module } from '@nestjs/common';
import { DevToolsGuard } from '../entitlements/guards/dev-tools.guard';
import { HealthController } from './health.controller';

/**
 * `DevToolsGuard` is provided here directly (Phase 11, work unit 11-B5)
 * rather than exported from `EntitlementsModule` — the guard's only
 * dependency is the global `ConfigService`, so providing the class locally
 * is simpler than widening another module's export surface.
 * `PrismaService` comes from the global `PrismaModule`.
 */
@Module({
  controllers: [HealthController],
  providers: [DevToolsGuard],
})
export class HealthModule {}
