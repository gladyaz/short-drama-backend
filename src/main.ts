import { ConsoleLogger, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { RootConfig } from './config/configuration';
import { AppExceptionFilter } from './common/filters/app-exception.filter';
import { redactSensitiveText } from './common/logging/redact';

// Phase 12, work unit 12A-B2 (DECISIONS.md decision 8): explicit body-size
// ceiling for normal JSON API requests. This backend never receives raw
// media bytes through the Node API — the admin media flow (11B-3) issues
// presigned R2 URLs and the client uploads directly to R2, and every
// metadata-only request body (analytics batch ingest capped at 50 events,
// admin metadata edits, auth payloads) stays well under this ceiling — so
// tightening/explicitly setting this limit does not constrain the
// direct-to-R2 upload architecture. Expressed as a named constant, not a
// magic string, per the repo's body-parser call sites below.
const JSON_BODY_LIMIT = '256kb';

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
  // `bodyParser: false` disables Nest's automatically-registered default
  // Express body parsers (which apply body-parser's own undocumented-here
  // 100kb default limit) so the explicit 256kb `useBodyParser` calls below
  // are the single, unambiguous source of the JSON/urlencoded size ceiling
  // rather than stacking a second parser behind Nest's default one.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new ConsoleLogger({ json: true }),
    bodyParser: false,
  });
  const configService = app.get<ConfigService<RootConfig>>(ConfigService);
  const appConfig = configService.get('app', { infer: true })!;

  // Phase 12, work unit 12A-B2 (DECISIONS.md decision 8): `helmet()` with
  // its defaults (HSTS, X-Content-Type-Options: nosniff, frameguard,
  // Content-Security-Policy, etc.) — reviewed against this JSON-only API
  // and its e2e suite; the default CSP does not break anything here (no
  // server-rendered HTML is ever returned, so CSP has no page to restrict)
  // and is left enabled rather than hand-disabled, per the frozen
  // "helmet() with defaults" contract. No header helmet already sets is
  // hand-rolled here.
  app.use(helmet());
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.useBodyParser('urlencoded', { extended: true, limit: JSON_BODY_LIMIT });

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
