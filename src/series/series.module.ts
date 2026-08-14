import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { AuthModule } from '../auth/auth.module';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { StorageModule } from '../storage/storage.module';
import { SeriesController } from './series.controller';
import { SeriesPublicController } from './series-public.controller';
import { PublicSeriesService } from './series-public.service';
import { SeriesService } from './series.service';

/**
 * Phase 11, work unit 11E-4: houses the admin-guarded `Series` metadata
 * CRUD. Imports `AuthModule` for `JwtAuthGuard` and `AdminModule` for
 * `AdminGuard` directly, mirroring `MediaModule`'s existing pattern of
 * importing every guard-providing module it needs rather than relying on
 * transitive re-exports. `PrismaService` is available via the global
 * `PrismaModule` (see `prisma.module.ts`), so it is not listed here.
 *
 * Work unit "SERIES METADATA + DISCOVER ARTWORK CONTRACT": also houses the
 * separate, public `SeriesPublicController`/`PublicSeriesService`
 * (`GET /series`, `GET /series/:id`) in the SAME module as the admin
 * surface — both operate on the same `Series`/`Video` tables and belong to
 * the same domain, mirroring how `MediaModule` is not split just because
 * some of its routes are guarded and others (none, for that module) are
 * not. `EntitlementsModule` (for the shared
 * `EntitlementsService.resolveEpisodePremium` rule) and `StorageModule`
 * (for `StorageService.createPresignedGetUrl`, resolving `coverUrl`; and,
 * as of work unit "SERIES COVER UPLOAD BACKEND CONTRACT",
 * `createPresignedPutUrl`/`headObject` for the admin-guarded cover-upload
 * flow on `SeriesService` too) are imported directly, matching
 * `VideosModule`'s existing pattern for the exact same two dependencies.
 */
@Module({
  imports: [AuthModule, AdminModule, EntitlementsModule, StorageModule],
  controllers: [SeriesController, SeriesPublicController],
  providers: [SeriesService, PublicSeriesService],
})
export class SeriesModule {}
