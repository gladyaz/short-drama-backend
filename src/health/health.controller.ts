import {
  Controller,
  Get,
  HttpStatus,
  Logger,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { redactSensitiveText } from '../common/logging/redact';
import { DevToolsGuard } from '../entitlements/guards/dev-tools.guard';
import { PrismaService } from '../prisma/prisma.service';
import { StorageReadinessService } from './storage-readiness.service';
import { StorageReadinessResponse } from './storage-readiness.types';
import { TranscodeReadinessService } from './transcode-readiness.service';
import { TranscodeReadinessResponse } from './transcode-readiness.types';

interface HealthResponse {
  status: 'ok';
  service: string;
}

/**
 * PRODUCTION HTTPS READINESS: the READINESS half of the liveness/readiness
 * pair. Deliberately a tiny, closed shape — a status word and one
 * dependency verdict. It carries no hostname, no connection string, no
 * driver name, no error text and no stack: a readiness probe is reachable
 * by anyone who can reach the API, so it must be readable by a load
 * balancer and useless to an attacker mapping the deployment.
 */
interface ReadinessResponse {
  status: 'ready' | 'not_ready';
  database: 'ok' | 'unreachable';
}

interface HealthDetailsResponse {
  status: 'ok';
  service: string;
  uptimeSeconds: number;
  database: 'ok' | 'unreachable';
  nodeVersion: string;
  /** From npm's env when started via an npm script; null under plain `node`. */
  version: string | null;
  /**
   * Phase 11, work unit 11G-4: secret-free storage-readiness signal — see
   * `StorageReadinessResponse` for the exact (booleans + driver enum only)
   * shape. Never the endpoint, bucket, region, access key, secret, or any
   * absolute storage path.
   */
  storage: StorageReadinessResponse;
  /**
   * Slice 11N: secret-free transcode-readiness signal — see
   * `TranscodeReadinessResponse` for the exact shape. Never `REDIS_URL`'s
   * value. Flag off (this slice's shipped default) reports only
   * `{ enabled: false }` — transcode readiness is NOT required for overall
   * app readiness in that state (2026-08-10 DECISIONS.md approval, item 7).
   */
  transcode: TranscodeReadinessResponse;
}

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageReadiness: StorageReadinessService,
    private readonly transcodeReadiness: TranscodeReadinessService,
  ) {}

  /**
   * LIVENESS. Answers 200 as long as the process is running and able to
   * serve a request. Deliberately touches NOTHING — no database, no
   * storage, no Redis — because a liveness probe that fails on a
   * dependency outage tells the platform to RESTART the container, which
   * cannot fix a database that is down and turns a recoverable outage into
   * a crash loop. Use `/health/ready` to gate traffic.
   */
  @Get()
  getHealth(): HealthResponse {
    return { status: 'ok', service: 'short-drama-backend' };
  }

  /**
   * READINESS. Answers 200 only when this process can actually serve real
   * requests, and 503 otherwise, so a platform can hold traffic off an
   * instance whose database is unreachable instead of serving 500s from it.
   *
   * WHY THIS EXISTS SEPARATELY FROM `/health/details`. `details` is the
   * operator view and is gated behind `DevToolsGuard`, which
   * `env.validation.ts` refuses to enable in production — so before this
   * route there was NO production-reachable probe that proved anything
   * beyond "the process is up". `PrismaService.onModuleInit` calls
   * `$connect()`, so a process that could never reach the database fails to
   * boot; it does not cover a database that goes away AFTER boot, which is
   * the case a readiness probe is for.
   *
   * THE DATABASE IS THE ONLY DEPENDENCY CHECKED, and that is a deliberate
   * scope, not an omission. Object storage is not on the request path for a
   * catalog read (presigned URLs are signed offline — the SDK makes no
   * network call to mint one), and Redis is only ever connected when
   * `TRANSCODE_ENABLED=true`, which V1 does not ship: with the flag off,
   * `TranscodeModule` binds an inert no-op client and no Redis object is
   * ever constructed. Adding either would make readiness flap on a
   * dependency this process can serve traffic without.
   *
   * `SELECT 1` is the whole probe: no table is read, nothing is written,
   * and it costs one round trip. It must stay that cheap — a readiness
   * endpoint is unauthenticated and polled every few seconds forever.
   */
  @Get('ready')
  async getReadiness(
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReadinessResponse> {
    let database: ReadinessResponse['database'] = 'ok';

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      // The cause goes to the LOGS and never into the response: a raw
      // Prisma error carries the host, port, database name and user of the
      // connection string, so it is passed through the redaction layer even
      // there. Logged rather than swallowed because an unreachable database
      // is precisely the event an operator needs a record of — accepting
      // that a probe polled every few seconds will repeat this line for the
      // duration of an outage, which is the correct trade for a signal this
      // important.
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        redactSensitiveText(`Readiness probe: database unreachable: ${detail}`),
      );
      database = 'unreachable';
    }

    const ready = database === 'ok';
    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return { status: ready ? 'ready' : 'not_ready', database };
  }

  /**
   * Phase 11, work unit 11-B5: an operational health signal beyond the bare
   * liveness ping above — DB reachability, uptime, runtime versions. Gated
   * behind `DevToolsGuard` (`DEV_TOOLS_ENABLED=true`) per the recorded
   * decision (DECISIONS.md "Phase 11 approved...", default decision 5):
   * these details are for a developer/operator, never for an anonymous
   * production caller, and the env-validation layer already refuses to boot
   * with dev tools enabled in production.
   */
  @UseGuards(DevToolsGuard)
  @Get('details')
  async getDetails(): Promise<HealthDetailsResponse> {
    let database: HealthDetailsResponse['database'] = 'ok';

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'unreachable';
    }

    return {
      status: 'ok',
      service: 'short-drama-backend',
      uptimeSeconds: Math.round(process.uptime()),
      database,
      nodeVersion: process.version,
      version: process.env.npm_package_version ?? null,
      storage: this.storageReadiness.check(),
      transcode: this.transcodeReadiness.check(),
    };
  }
}
