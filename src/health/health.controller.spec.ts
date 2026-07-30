import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { HealthController } from './health.controller';
import { StorageReadinessService } from './storage-readiness.service';
import { StorageReadinessResponse } from './storage-readiness.types';

describe('HealthController', () => {
  let controller: HealthController;
  let queryRaw: jest.Mock;
  let checkStorageReadiness: jest.Mock<StorageReadinessResponse, []>;

  const fixtureReadiness: StorageReadinessResponse = {
    driver: 'local',
    ready: true,
    configPresent: true,
  };

  beforeEach(async () => {
    queryRaw = jest.fn().mockResolvedValue([{ '?column?': 1 }]);
    checkStorageReadiness = jest
      .fn<StorageReadinessResponse, []>()
      .mockReturnValue(fixtureReadiness);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: { $queryRaw: queryRaw } },
        {
          provide: StorageReadinessService,
          useValue: { check: checkStorageReadiness },
        },
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

  // Phase 11, work unit 11G-4. `StorageReadinessService` itself is unit
  // tested in `storage-readiness.service.spec.ts`; here we only confirm the
  // controller wires its result through untouched, under the `storage` key.
  it('includes the storage-readiness result from StorageReadinessService', async () => {
    const details = await controller.getDetails();

    expect(checkStorageReadiness).toHaveBeenCalledTimes(1);
    expect(details.storage).toEqual(fixtureReadiness);
  });

  // Phase 11, work unit 11I-B1: the controller must forward the new
  // `publicDeliveryAvailable` field verbatim too — it neither adds nor
  // strips it (the field's presence is the service's decision, per driver).
  it('passes an r2 readiness result through untouched, including publicDeliveryAvailable', async () => {
    const r2Readiness: StorageReadinessResponse = {
      driver: 'r2',
      ready: true,
      configPresent: true,
      publicDeliveryAvailable: false,
    };
    checkStorageReadiness.mockReturnValue(r2Readiness);

    const details = await controller.getDetails();

    expect(details.storage).toEqual(r2Readiness);
    expect(details.storage.publicDeliveryAvailable).toBe(false);
  });
});
