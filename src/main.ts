import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { RootConfig } from './config/configuration';
import { AppExceptionFilter } from './common/filters/app-exception.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const configService = app.get<ConfigService<RootConfig>>(ConfigService);
  const appConfig = configService.get('app', { infer: true })!;

  app.enableCors({ origin: appConfig.corsOrigins });
  app.useGlobalFilters(new AppExceptionFilter());

  await app.listen(appConfig.port, '0.0.0.0');

  const logger = new Logger('Bootstrap');
  logger.log(
    `short-drama-backend listening on http://0.0.0.0:${appConfig.port}`,
  );
  logger.log(`Public base URL: ${appConfig.publicBaseUrl}`);
  logger.log(`CORS origins: ${appConfig.corsOrigins.join(', ') || '(none)'}`);
}
void bootstrap();
