import { Controller, Get, UseGuards } from '@nestjs/common';
import { DevToolsGuard } from '../entitlements/guards/dev-tools.guard';
import { PrismaService } from '../prisma/prisma.service';
import { StorageReadinessService } from './storage-readiness.service';
import { StorageReadinessResponse } from './storage-readiness.types';

interface HealthResponse {
  status: 'ok';
  service: string;
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
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageReadiness: StorageReadinessService,
  ) {}

  @Get()
  getHealth(): HealthResponse {
    return { status: 'ok', service: 'short-drama-backend' };
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
    };
  }
}
