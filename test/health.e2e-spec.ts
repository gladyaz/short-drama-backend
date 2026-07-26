import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

interface ErrorResponseBody {
  statusCode: number;
  code: string;
  message: string;
}

interface StorageReadinessBody {
  driver: string;
  ready: boolean;
  configPresent: boolean;
}

interface HealthDetailsBody {
  status: string;
  storage: StorageReadinessBody;
}

/**
 * e2e coverage for Phase 11, work unit 11G-4: the storage-readiness section
 * of `/health/details`. Split into two apps — `DEV_TOOLS_ENABLED` is read
 * once at `ConfigModule` bootstrap (see other e2e specs, e.g.
 * `entitlements.e2e-spec.ts`, for the same pattern) — mirroring the
 * default/production-safe posture (route unreachable) and the developer
 * opt-in posture (route reachable, booleans-only payload).
 */
describe('Health storage-readiness (e2e)', () => {
  describe('with DEV_TOOLS_ENABLED unset (default, production-safe posture)', () => {
    let app: INestApplication<App>;

    beforeAll(async () => {
      delete process.env.DEV_TOOLS_ENABLED;

      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = moduleFixture.createNestApplication();
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    it('GET /health returns 200 without a storage section (bare liveness ping)', async () => {
      const response = await request(app.getHttpServer())
        .get('/health')
        .expect(HttpStatus.OK);

      expect(response.body).toEqual({
        status: 'ok',
        service: 'short-drama-backend',
      });
    });

    it('GET /health/details is unreachable (404 DEV_TOOLS_DISABLED)', async () => {
      const response = await request(app.getHttpServer())
        .get('/health/details')
        .expect(HttpStatus.NOT_FOUND);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('DEV_TOOLS_DISABLED');
    });
  });

  describe('with DEV_TOOLS_ENABLED=true (developer opt-in)', () => {
    let app: INestApplication<App>;

    beforeAll(async () => {
      process.env.DEV_TOOLS_ENABLED = 'true';

      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = moduleFixture.createNestApplication();
      await app.init();
    });

    afterAll(async () => {
      await app.close();
      delete process.env.DEV_TOOLS_ENABLED;
    });

    it('GET /health/details returns a booleans-only, secret-free storage-readiness section', async () => {
      const response = await request(app.getHttpServer())
        .get('/health/details')
        .expect(HttpStatus.OK);

      const body = response.body as HealthDetailsBody;
      const { storage } = body;

      // Exact key set — nothing beyond driver/ready/configPresent can ride
      // along on this payload without this assertion failing.
      expect(Object.keys(storage).sort()).toEqual([
        'configPresent',
        'driver',
        'ready',
      ]);
      expect(['local', 'r2']).toContain(storage.driver);
      expect(typeof storage.ready).toBe('boolean');
      expect(typeof storage.configPresent).toBe('boolean');

      // Generic secret/path marker check across the whole payload — none of
      // these words (not real values, just field-name markers) should ever
      // appear; the real config values themselves are never referenced by
      // this test at all.
      const serialized = JSON.stringify(body).toLowerCase();
      expect(serialized).not.toMatch(
        /endpoint|bucket|accesskey|secretaccess|publicbaseurl|storageroot/,
      );
    });
  });
});
