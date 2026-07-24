import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EntitlementsController } from './entitlements.controller';
import { EntitlementsService } from './entitlements.service';
import { DevToolsGuard } from './guards/dev-tools.guard';

/**
 * Phase 10, work units 10-B2/10-B4/10-B5. Imports `AuthModule` for
 * `JwtAuthGuard`, matching `InteractionsModule`/`ProgressModule`'s existing
 * pattern. `DevToolsGuard` is exported (Phase 11, work unit 11B-2) so other
 * modules gating their own dev-only routes behind `DEV_TOOLS_ENABLED` (e.g.
 * `AdminModule`'s `/dev/admin/*` routes) can reuse it instead of
 * duplicating the guard.
 */
@Module({
  imports: [AuthModule],
  controllers: [EntitlementsController],
  providers: [EntitlementsService, DevToolsGuard],
  exports: [EntitlementsService, DevToolsGuard],
})
export class EntitlementsModule {}
