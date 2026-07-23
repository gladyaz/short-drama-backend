import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import { EntitlementsModule } from './entitlements/entitlements.module';
import { HealthModule } from './health/health.module';
import { InteractionsModule } from './interactions/interactions.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProgressModule } from './progress/progress.module';
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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
