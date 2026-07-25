import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { AuthModule } from '../auth/auth.module';
import { SeriesController } from './series.controller';
import { SeriesService } from './series.service';

/**
 * Phase 11, work unit 11E-4: houses the admin-guarded `Series` metadata
 * CRUD. Imports `AuthModule` for `JwtAuthGuard` and `AdminModule` for
 * `AdminGuard` directly, mirroring `MediaModule`'s existing pattern of
 * importing every guard-providing module it needs rather than relying on
 * transitive re-exports. `PrismaService` is available via the global
 * `PrismaModule` (see `prisma.module.ts`), so it is not listed here.
 */
@Module({
  imports: [AuthModule, AdminModule],
  controllers: [SeriesController],
  providers: [SeriesService],
})
export class SeriesModule {}
