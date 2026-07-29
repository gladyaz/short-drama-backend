import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AdminModule } from './admin/admin.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuthModule } from './auth/auth.module';
import { RequestLoggingMiddleware } from './common/logging/request-logging.middleware';
import {
  DEFAULT_THROTTLE_LIMIT,
  DEFAULT_THROTTLE_TTL_MS,
} from './common/rate-limit.constants';
import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import { EntitlementsModule } from './entitlements/entitlements.module';
import { ExportModule } from './export/export.module';
import { HealthModule } from './health/health.module';
import { InteractionsModule } from './interactions/interactions.module';
import { MediaModule } from './media/media.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProgressModule } from './progress/progress.module';
import { SeriesModule } from './series/series.module';
import { StorageModule } from './storage/storage.module';
import { VideosModule } from './videos/videos.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    // Phase 12, work unit 12A-B1: coarse, in-memory, per-IP request
    // throttling (DECISIONS.md "Phase 12 ... approved..." entry, decision
    // 4). A single named ("default") throttler with a generous global limit
    // — `@Throttle({ default: { limit, ttl } })` on
    // `/auth/login|register|refresh` in `AuthController` OVERRIDES this
    // limit for just those three routes, it does not add a second
    // globally-applied throttler. Every other route (`/videos/*`,
    // `/admin/*`, `/health`, etc.) is subject only to this generous default,
    // so existing/legitimate traffic patterns never trip it.
    ThrottlerModule.forRoot({
      throttlers: [
        {
          name: 'default',
          ttl: DEFAULT_THROTTLE_TTL_MS,
          limit: DEFAULT_THROTTLE_LIMIT,
        },
      ],
      errorMessage: 'Too many requests. Please try again later.',
    }),
    PrismaModule,
    HealthModule,
    VideosModule,
    AuthModule,
    InteractionsModule,
    ProgressModule,
    EntitlementsModule,
    ExportModule,
    AnalyticsModule,
    StorageModule,
    AdminModule,
    MediaModule,
    SeriesModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule implements NestModule {
  // Phase 11, work unit 11-B1: structured request-completion logging on
  // every route. `{*splat}` is Express 5's catch-all syntax (Nest 11 ships
  // Express 5, where a bare `*` is no longer a valid path pattern).
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLoggingMiddleware).forRoutes('{*splat}');
  }
}
