import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { TRANSCODE_QUEUE } from './../src/transcode/transcode.types';
import { e2eSuiteBootBudgetMs } from './../src/common/testing/e2e-boot-budget.helpers';

interface ErrorResponseBody {
  statusCode: number;
  code: string;
  message: string;
}

interface StorageReadinessBody {
  driver: string;
  ready: boolean;
  configPresent: boolean;
  /** Phase 11, work unit 11I-B1: `r2` mode only — absent under `local`. */
  publicDeliveryAvailable?: boolean;
}

/** Slice 11N. `configPresent`/`ready` are only present when `enabled` is `true`. */
interface TranscodeReadinessBody {
  enabled: boolean;
  configPresent?: boolean;
  ready?: boolean;
}

interface HealthDetailsBody {
  status: string;
  storage: StorageReadinessBody;
  transcode: TranscodeReadinessBody;
}

/**
 * One distinctive, grep-able sentinel embedded in every `OBJECT_STORAGE_*`
 * fixture value below, so the payload can be asserted secret-free in one
 * line. Not a real credential, not a real endpoint, and never used to make
 * a network call — `.example.invalid` is reserved by RFC 2606/6761 and the
 * `S3Client` this config builds is only ever constructed, never invoked, by
 * these tests.
 */
const SECRET_SENTINEL = 'S3NT1NEL-11I-MUST-NEVER-APPEAR-IN-HEALTH-OUTPUT';

const R2_FIXTURE_ENV: Readonly<Record<string, string>> = {
  STORAGE_DRIVER: 'r2',
  OBJECT_STORAGE_ENDPOINT: `https://${SECRET_SENTINEL}.example.invalid`,
  OBJECT_STORAGE_REGION: `auto-${SECRET_SENTINEL}`,
  OBJECT_STORAGE_BUCKET: `${SECRET_SENTINEL}-bucket`,
  OBJECT_STORAGE_ACCESS_KEY_ID: `${SECRET_SENTINEL}-access-key-id`,
  OBJECT_STORAGE_SECRET_ACCESS_KEY: `${SECRET_SENTINEL}-secret-access-key`,
  // Deliberately '' rather than `delete`: `ConfigModule` re-runs dotenv on
  // every app boot and only skips keys already present in `process.env`
  // (an empty value still counts as present), so a deleted key would be
  // re-populated from whatever sits in the developer's local `.env` and
  // make this assertion machine-dependent. '' is also exactly what the
  // readiness check treats as "not configured".
  OBJECT_STORAGE_PUBLIC_BASE_URL: '',
  DEV_TOOLS_ENABLED: 'true',
};

/**
 * e2e coverage for Phase 11, work unit 11G-4 (the storage-readiness section
 * of `/health/details`) and work unit 11I-T1 (private-R2 readiness
 * regression). Split into separate apps — `DEV_TOOLS_ENABLED`,
 * `STORAGE_DRIVER` and the `OBJECT_STORAGE_*` names are read once at
 * `ConfigModule` bootstrap (see other e2e specs, e.g.
 * `entitlements.e2e-spec.ts`, for the same pattern) — covering the
 * default/production-safe posture (route unreachable), the developer opt-in
 * posture (route reachable, booleans-only payload), and a private-R2
 * posture (ready without a public base URL). No network call is made to R2
 * or anywhere else: `/health/details` never probes storage.
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
    }, e2eSuiteBootBudgetMs());

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

    /**
     * PRODUCTION HTTPS READINESS. This is the assertion a unit test cannot
     * make: that `/health/ready` is REACHABLE in exactly the posture
     * production runs in — dev tools off — unlike `/health/details`
     * immediately above. It is the only production-reachable probe that
     * proves a dependency, so a guard accidentally applied to it would
     * silently leave a deployment with no readiness signal at all.
     */
    it('GET /health/ready is reachable with dev tools OFF and reports database readiness', async () => {
      const response = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(HttpStatus.OK);

      expect(response.body).toEqual({ status: 'ready', database: 'ok' });
    });

    it('GET /health/ready leaks nothing about the deployment', async () => {
      const response = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(HttpStatus.OK);

      // Exact key set — nothing can ride along on this payload without
      // this failing. It is served unauthenticated to anyone who can reach
      // the API.
      expect(Object.keys(response.body as object).sort()).toEqual([
        'database',
        'status',
      ]);

      const serialized = JSON.stringify(response.body).toLowerCase();
      expect(serialized).not.toMatch(
        /postgres|postgresql|:5432|password|host|endpoint|storageroot/,
      );
    });

    /**
     * Liveness must stay dependency-free: it answers 200 on the same boot
     * where readiness is doing real work. Asserted side by side so a future
     * change that gives `/health` a database check has to fail here.
     */
    it('keeps GET /health free of the dependency check that GET /health/ready performs', async () => {
      const liveness = await request(app.getHttpServer())
        .get('/health')
        .expect(HttpStatus.OK);

      expect(liveness.body).toEqual({
        status: 'ok',
        service: 'short-drama-backend',
      });
      expect(liveness.body).not.toHaveProperty('database');
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
    }, e2eSuiteBootBudgetMs());

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

      // Exact key set per driver — nothing beyond these can ride along on
      // this payload without this assertion failing. `local` omits
      // `publicDeliveryAvailable` entirely (Phase 11, work unit 11I-B1: it
      // is not applicable to a driver that cannot do public delivery);
      // whichever driver this environment is configured for, the shape is
      // pinned. This suite inherits the ambient STORAGE_DRIVER, so both
      // branches are asserted here and the r2 branch is additionally
      // covered deterministically in the describe below.
      const expectedKeys =
        storage.driver === 'r2'
          ? ['configPresent', 'driver', 'publicDeliveryAvailable', 'ready']
          : ['configPresent', 'driver', 'ready'];

      expect(Object.keys(storage).sort()).toEqual(expectedKeys);
      expect(['local', 'r2']).toContain(storage.driver);
      expect(typeof storage.ready).toBe('boolean');
      expect(typeof storage.configPresent).toBe('boolean');

      // Generic secret/path marker check across the whole payload — none of
      // these words (not real values, just field-name markers) should ever
      // appear; the real config values themselves are never referenced by
      // this test at all. `publicdeliveryavailable` is a capability flag
      // NAME, not a value, and deliberately shares no substring with the
      // `publicbaseurl` marker below.
      const serialized = JSON.stringify(body).toLowerCase();
      expect(serialized).not.toMatch(
        /endpoint|bucket|accesskey|secretaccess|publicbaseurl|storageroot/,
      );
    });

    // Slice 11N: this suite inherits the repo's default TRANSCODE_ENABLED
    // (unset/false — see .env/.env.example) — the shipped default.
    it('GET /health/details reports transcode: { enabled: false } only — no configPresent/ready keys', async () => {
      const response = await request(app.getHttpServer())
        .get('/health/details')
        .expect(HttpStatus.OK);

      const { transcode } = response.body as HealthDetailsBody;

      expect(transcode).toEqual({ enabled: false });
      expect(Object.keys(transcode)).toEqual(['enabled']);
    });
  });

  /**
   * Slice 11N, proof 11 (secret-free health output) at the HTTP layer. This
   * is an "explicitly-scoped test case that mocks the queue" — the hard
   * prohibition's carve-out for `TRANSCODE_ENABLED=true`:
   * `TRANSCODE_QUEUE` is overridden with a jest mock BEFORE the module
   * compiles, so `TranscodeModule`'s factory never constructs a real
   * `BullmqTranscodeQueueClient`/`IORedis` client, and no real Redis
   * connection is ever attempted — `REDIS_URL` here is a deliberately fake,
   * unreachable value that only needs to satisfy `env.validation.ts`'s
   * presence/shape check at boot.
   */
  describe('with TRANSCODE_ENABLED=true (queue mocked)', () => {
    let app: INestApplication<App>;
    const previousTranscodeEnabled = process.env.TRANSCODE_ENABLED;
    const previousRedisUrl = process.env.REDIS_URL;
    const SECRET_SENTINEL_REDIS = 'S3NT1NEL-11N-DO-NOT-LEAK-REDIS-URL-VALUE';

    beforeAll(async () => {
      process.env.TRANSCODE_ENABLED = 'true';
      process.env.REDIS_URL = `redis://${SECRET_SENTINEL_REDIS}@127.0.0.1:65535/0`;
      process.env.DEV_TOOLS_ENABLED = 'true';

      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(TRANSCODE_QUEUE)
        .useValue({ add: jest.fn().mockResolvedValue(undefined) })
        .compile();

      app = moduleFixture.createNestApplication();
      await app.init();
    }, e2eSuiteBootBudgetMs());

    afterAll(async () => {
      try {
        if (app) {
          await app.close();
        }
      } finally {
        delete process.env.DEV_TOOLS_ENABLED;
        if (previousTranscodeEnabled === undefined) {
          delete process.env.TRANSCODE_ENABLED;
        } else {
          process.env.TRANSCODE_ENABLED = previousTranscodeEnabled;
        }
        if (previousRedisUrl === undefined) {
          delete process.env.REDIS_URL;
        } else {
          process.env.REDIS_URL = previousRedisUrl;
        }
      }
    });

    it('GET /health/details reports transcode: { enabled: true, configPresent: true, ready: true } and leaks no REDIS_URL value', async () => {
      const response = await request(app.getHttpServer())
        .get('/health/details')
        .expect(HttpStatus.OK);

      const body = response.body as HealthDetailsBody;

      expect(body.transcode).toEqual({
        enabled: true,
        configPresent: true,
        ready: true,
      });

      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('redis://');
      expect(serialized).not.toContain(SECRET_SENTINEL_REDIS);
      expect(serialized).not.toContain('127.0.0.1:65535');
    });
  });

  /**
   * Phase 11, work unit 11I-T1. The regression this slice exists for, at
   * the HTTP layer: a PRIVATE R2 deployment — the five `REQUIRED_R2_KEYS`
   * names set, `OBJECT_STORAGE_PUBLIC_BASE_URL` deliberately not
   * configured — must report `ready: true`. Before work unit 11I-B1 this
   * reported `ready: false` permanently. If anyone re-adds
   * `OBJECT_STORAGE_PUBLIC_BASE_URL` to the readiness requirement, this
   * suite fails.
   */
  describe('with STORAGE_DRIVER=r2 and a private-bucket config (no public base URL)', () => {
    let app: INestApplication<App>;
    const previousEnv = new Map<string, string | undefined>();

    beforeAll(async () => {
      for (const [key, value] of Object.entries(R2_FIXTURE_ENV)) {
        previousEnv.set(key, process.env[key]);
        process.env[key] = value;
      }

      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = moduleFixture.createNestApplication();
      await app.init();
    }, e2eSuiteBootBudgetMs());

    afterAll(async () => {
      try {
        // `beforeAll` can throw before `app` is assigned (e.g. the module
        // compile fails), so guard it — the env restore below MUST run
        // either way, or `STORAGE_DRIVER=r2` and the sentinel
        // `OBJECT_STORAGE_*` values leak into the rest of this worker.
        if (app) {
          await app.close();
        }
      } finally {
        for (const [key, value] of previousEnv) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }
    });

    it('GET /health/details reports ready + configPresent true and publicDeliveryAvailable false', async () => {
      const response = await request(app.getHttpServer())
        .get('/health/details')
        .expect(HttpStatus.OK);

      const { storage } = response.body as HealthDetailsBody;

      expect(storage).toEqual({
        driver: 'r2',
        ready: true,
        configPresent: true,
        publicDeliveryAvailable: false,
      });
    });

    it('leaks no OBJECT_STORAGE_* value into the response body', async () => {
      const response = await request(app.getHttpServer())
        .get('/health/details')
        .expect(HttpStatus.OK);

      expect(JSON.stringify(response.body)).not.toContain(SECRET_SENTINEL);
    });
  });
});
