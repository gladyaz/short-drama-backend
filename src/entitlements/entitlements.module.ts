import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EntitlementsController } from './entitlements.controller';
import { EntitlementsService } from './entitlements.service';
import { DevToolsGuard } from './guards/dev-tools.guard';

/**
 * Phase 10, work units 10-B2/10-B4/10-B5. Imports `AuthModule` for
 * `JwtAuthGuard`, matching `InteractionsModule`/`ProgressModule`'s existing
 * pattern.
 */
@Module({
  imports: [AuthModule],
  controllers: [EntitlementsController],
  providers: [EntitlementsService, DevToolsGuard],
  exports: [EntitlementsService],
})
export class EntitlementsModule {}
