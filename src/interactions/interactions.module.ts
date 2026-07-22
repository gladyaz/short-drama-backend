import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InteractionsController } from './interactions.controller';
import { InteractionsService } from './interactions.service';

/**
 * Imports `AuthModule` for `JwtAuthGuard` (exported from that module), used
 * by every route in this module (Phase 9, work unit 9-B2).
 */
@Module({
  imports: [AuthModule],
  controllers: [InteractionsController],
  providers: [InteractionsService],
})
export class InteractionsModule {}
