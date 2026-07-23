import { ConsoleLogger, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { RootConfig } from './config/configuration';
import { AppExceptionFilter } from './common/filters/app-exception.filter';
import { redactSensitiveText } from './common/logging/redact';

// Phase 11, work unit 11-B4: process-level last-resort handlers, both
// routed through the redaction layer. An unhandled promise rejection is
// logged and the server keeps serving (the failing request's own path has
// already been answered or abandoned); an uncaught synchronous exception
// leaves process state unknowable, so it is logged and the process exits
// non-zero — the same outcome Node defaults to, but with a structured,
// redacted log line first.
const processLogger = new Logger('Process');

process.on('unhandledRejection', (reason) => {
  const detail =
    reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  processLogger.error(
    redactSensitiveText(`Unhandled promise rejection: ${detail}`),
  );
});

process.on('uncaughtException', (error) => {
  processLogger.error(
    redactSensitiveText(`Uncaught exception: ${error.stack ?? error.message}`),
  );
  process.exit(1);
});

async function bootstrap(): Promise<void> {
  // Phase 11, work unit 11-B1: structured JSON log output (one JSON object
  // per line) instead of Nest's default pretty format, so logs are
  // machine-parseable for operational monitoring without a log-shipping
  // sidecar having to guess at the format.
  const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger({ json: true }),
  });
  const configService = app.get<ConfigService<RootConfig>>(ConfigService);
  const appConfig = configService.get('app', { infer: true })!;

  app.enableCors({ origin: appConfig.corsOrigins });
  app.useGlobalFilters(new AppExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.listen(appConfig.port, '0.0.0.0');

  const logger = new Logger('Bootstrap');
  logger.log(
    `short-drama-backend listening on http://0.0.0.0:${appConfig.port}`,
  );
  logger.log(`Public base URL: ${appConfig.publicBaseUrl}`);
  logger.log(`CORS origins: ${appConfig.corsOrigins.join(', ') || '(none)'}`);
}
void bootstrap();
