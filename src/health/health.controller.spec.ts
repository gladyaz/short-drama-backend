import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;
  let queryRaw: jest.Mock;

  beforeEach(async () => {
    queryRaw = jest.fn().mockResolvedValue([{ '?column?': 1 }]);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: { $queryRaw: queryRaw } },
        // Route-level @UseGuards(DevToolsGuard) resolves through DI even in
        // unit tests, and the guard's only dependency is ConfigService.
        {
          provide: ConfigService,
          useValue: { get: () => ({ devToolsEnabled: true }) },
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('returns ok status and the service name', () => {
    expect(controller.getHealth()).toEqual({
      status: 'ok',
      service: 'short-drama-backend',
    });
  });

  // Phase 11, work unit 11-B5/11-B6. The DevToolsGuard gating itself is
  // covered at the e2e layer (route 404s with DEV_TOOLS_ENABLED unset);
  // these cover the handler's own behavior.
  it('reports database ok when the probe query succeeds', async () => {
    const details = await controller.getDetails();

    expect(details.status).toBe('ok');
    expect(details.database).toBe('ok');
    expect(details.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(details.nodeVersion).toBe(process.version);
  });

  it('reports database unreachable (without throwing) when the probe query fails', async () => {
    queryRaw.mockRejectedValueOnce(new Error('connection refused'));

    const details = await controller.getDetails();

    expect(details.status).toBe('ok');
    expect(details.database).toBe('unreachable');
  });
});
