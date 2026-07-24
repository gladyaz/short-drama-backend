import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AdminModule } from './admin/admin.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuthModule } from './auth/auth.module';
import { RequestLoggingMiddleware } from './common/logging/request-logging.middleware';
import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import { EntitlementsModule } from './entitlements/entitlements.module';
import { HealthModule } from './health/health.module';
import { InteractionsModule } from './interactions/interactions.module';
import { MediaModule } from './media/media.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProgressModule } from './progress/progress.module';
import { StorageModule } from './storage/storage.module';
import { VideosModule } from './videos/videos.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    PrismaModule,
    HealthModule,
    VideosModule,
    AuthModule,
    InteractionsModule,
    ProgressModule,
    EntitlementsModule,
    AnalyticsModule,
    StorageModule,
    AdminModule,
    MediaModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  // Phase 11, work unit 11-B1: structured request-completion logging on
  // every route. `{*splat}` is Express 5's catch-all syntax (Nest 11 ships
  // Express 5, where a bare `*` is no longer a valid path pattern).
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLoggingMiddleware).forRoutes('{*splat}');
  }
}
