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

  // PRODUCTION HTTPS READINESS: teach Express how many reverse proxies sit
  // in front of this process, so `request.ip` is the real client address
  // rather than the proxy's.
  //
  // WHAT DEPENDS ON THIS. Every per-IP control in the app reads
  // `request.ip`: the global `ThrottlerGuard` (@nestjs/throttler's default
  // tracker IS `req.ip`), every `@Throttle()` override — `LOGIN_RATE_LIMIT`
  // is 5/min, `WHATSAPP_OTP_REQUEST_RATE_LIMIT` 3/10min — and
  // `requestContext()`, whose `ip` becomes `Session.ipHash` /
  // `AuthAuditEvent.ipHash`. A public HTTPS deployment always terminates TLS
  // at a proxy; left unconfigured there, every request reports the SAME
  // (proxy) address, so the 5-logins-per-minute ceiling becomes 5 logins per
  // minute for the whole user base — a self-inflicted outage — and every
  // audit row hashes one address.
  //
  // NUMBER, NEVER `true`: `trust proxy: true` trusts the entire
  // `X-Forwarded-For` chain, letting any client prepend a forged address and
  // mint unlimited rate-limit identities. A hop COUNT makes Express skip
  // exactly that many trusted entries from the right, which a client cannot
  // forge past. `0` (the default) leaves `trust proxy` untouched — the exact
  // behavior this app has always had — so a direct-to-Node deployment and
  // every existing test are unaffected.
  if (appConfig.trustProxyHops > 0) {
    app.set('trust proxy', appConfig.trustProxyHops);
  }

  app.enableCors({ origin: appConfig.corsOrigins });
  app.useGlobalFilters(new AppExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // PRODUCTION HTTPS READINESS: without this, Nest never runs its shutdown
  // lifecycle on a signal. Every managed platform stops a container by
  // sending SIGTERM and waiting a grace period before SIGKILL, so on every
  // single deploy, scale event and restart the process would die with
  // `onModuleDestroy` never called: `PrismaService.$disconnect()` skipped
  // (server-side Postgres connections left to time out rather than being
  // released — they accumulate across rapid redeploys and can exhaust a
  // small connection limit) and `RetentionSchedulerService`'s cron left
  // running into the teardown. It also lets Nest stop accepting new
  // connections and drain in-flight requests instead of severing them
  // mid-response — including a partially-streamed episode.
  //
  // Registered BEFORE `listen()` so a signal arriving during a slow startup
  // is still handled.
  app.enableShutdownHooks();

  await app.listen(appConfig.port, '0.0.0.0');

  const logger = new Logger('Bootstrap');
  logger.log(
    `short-drama-backend listening on http://0.0.0.0:${appConfig.port}`,
  );
  logger.log(`Public base URL: ${appConfig.publicBaseUrl}`);
  logger.log(`CORS origins: ${appConfig.corsOrigins.join(', ') || '(none)'}`);
  // Logged because a wrong value here is invisible at runtime — it produces
  // no error, just silently wrong client IPs — so the boot line is the one
  // place an operator can confirm it against their actual topology.
  logger.log(
    `Trusted reverse-proxy hops: ${appConfig.trustProxyHops}` +
      (appConfig.trustProxyHops === 0 ? ' (trust proxy disabled)' : ''),
  );
}
void bootstrap();
