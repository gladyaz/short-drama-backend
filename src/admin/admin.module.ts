import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminGuard } from './guards/admin.guard';

/**
 * Phase 11, work unit 11B-2. Imports `AuthModule` for `JwtAuthGuard`
 * (matching `EntitlementsModule`/`VideosModule`'s existing pattern) and
 * `EntitlementsModule` for `DevToolsGuard`, reused here rather than
 * duplicated for the `/dev/admin/*` routes. `AdminGuard` is exported so
 * 11B-3's `MediaModule`/`AdminMediaController` can reuse it without
 * duplicating the guard.
 */
@Module({
  imports: [AuthModule, EntitlementsModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
  exports: [AdminGuard],
})
export class AdminModule {}
