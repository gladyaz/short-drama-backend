import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProgressController } from './progress.controller';
import { ProgressService } from './progress.service';

/**
 * Imports `AuthModule` for `JwtAuthGuard` (exported from that module), used
 * by every route in this module (Phase 9, work unit 9-B2).
 */
@Module({
  imports: [AuthModule],
  controllers: [ProgressController],
  providers: [ProgressService],
})
export class ProgressModule {}
