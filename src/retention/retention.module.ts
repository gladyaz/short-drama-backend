import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { RetentionSchedulerService } from './retention-scheduler.service';
import { RetentionService } from './retention.service';

/**
 * Phase 13, work unit 13A-B2: the first module to import `RetentionService`
 * into the running app at all — see that service's own doc comment, updated
 * by this work unit, for the full "previously never loaded by the server"
 * history. `ScheduleModule.forRoot()` is imported here (not in
 * `AppModule` directly): it is `global: true` internally (see
 * `@nestjs/schedule`'s own `schedule.module.ts`), so importing it once,
 * anywhere, makes `SchedulerRegistry` injectable app-wide — this is the
 * standard `@nestjs/schedule` pattern, and keeping the import local to the
 * one module that actually uses it (rather than in `AppModule`) keeps that
 * dependency visible next to its only consumer.
 *
 * `RetentionService` is provided here (not only constructed ad hoc by
 * `run-retention-cli.ts`, which still does its own
 * `new RetentionService(prisma)` and is untouched by this unit) so
 * `RetentionSchedulerService` can receive it through normal Nest DI.
 * `PrismaService` itself comes from the global `PrismaModule`, exactly as it
 * already does for every other module's Prisma-backed service in this repo.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [RetentionService, RetentionSchedulerService],
})
export class RetentionModule {}
