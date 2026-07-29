import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ExportController } from './export.controller';
import { ExportService } from './export.service';

/**
 * Phase 12, work unit 12C-B2. Imports `AuthModule` for `JwtAuthGuard` AND
 * `AuthAuditService` (both exported from that module — see
 * `AuthModule`'s own doc comment on why `AuthAuditService` is exported),
 * matching `InteractionsModule`/`ProgressModule`/`EntitlementsModule`'s
 * existing pattern of importing `AuthModule` rather than duplicating guard
 * wiring.
 */
@Module({
  imports: [AuthModule],
  controllers: [ExportController],
  providers: [ExportService],
})
export class ExportModule {}
