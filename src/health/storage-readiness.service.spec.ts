import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AppConfig, StorageConfig } from '../config/configuration';
import { REQUIRED_R2_KEYS } from '../config/env.validation';
import { StorageReadinessService } from './storage-readiness.service';

/**
 * One distinctive, grep-able sentinel embedded in EVERY fixture config
 * value below (each `OBJECT_STORAGE_*` field plus `STORAGE_ROOT`), so any
 * test that serializes a response can assert in one line that no
 * environment value of any kind leaked into it. Not a real credential and
 * not a real path — it is deliberately unmistakable if it ever shows up.
 */
const SECRET_SENTINEL = 'S3NT1NEL-11I-MUST-NEVER-APPEAR-IN-HEALTH-OUTPUT';

const FIXTURE_ENDPOINT = `https://${SECRET_SENTINEL}-account.r2.cloudflarestorage.com`;
const FIXTURE_REGION = `auto-${SECRET_SENTINEL}`;
const FIXTURE_BUCKET = `${SECRET_SENTINEL}-bucket`;
const FIXTURE_ACCESS_KEY_ID = `${SECRET_SENTINEL}-access-key-id`;
const FIXTURE_SECRET_ACCESS_KEY = `${SECRET_SENTINEL}-secret-access-key`;
const FIXTURE_PUBLIC_BASE_URL = `https://${SECRET_SENTINEL}-media.example.test`;
const FIXTURE_STORAGE_ROOT = `/absolutely/not/a/real/path/${SECRET_SENTINEL}`;

/**
 * The five `OBJECT_STORAGE_*` variables a private R2 deployment genuinely
 * needs, each paired with a builder that blanks the `StorageConfig` field
 * that variable is parsed into. Stated INDEPENDENTLY of the service's own
 * name→field mapping, so a wrong mapping there cannot pass trivially.
 * `publicBaseUrl` is deliberately NOT here — that is the whole point of
 * Phase 11, work unit 11I-B1.
 */
const REQUIRED_R2_FIELDS: ReadonlyArray<{
  requiredEnvVar: string;
  blank: (value: string) => Partial<StorageConfig>;
}> = [
  {
    requiredEnvVar: 'OBJECT_STORAGE_ENDPOINT',
    blank: (v) => ({ endpoint: v }),
  },
  { requiredEnvVar: 'OBJECT_STORAGE_REGION', blank: (v) => ({ region: v }) },
  { requiredEnvVar: 'OBJECT_STORAGE_BUCKET', blank: (v) => ({ bucket: v }) },
  {
    requiredEnvVar: 'OBJECT_STORAGE_ACCESS_KEY_ID',
    blank: (v) => ({ accessKeyId: v }),
  },
  {
    requiredEnvVar: 'OBJECT_STORAGE_SECRET_ACCESS_KEY',
    blank: (v) => ({ secretAccessKey: v }),
  },
];

/** Both spellings of "this variable is not set" a `.env` can produce. */
const BLANK_SPELLINGS = [
  { spelling: 'empty', value: '' },
  { spelling: 'whitespace-only', value: '   ' },
];

/** A complete, valid PRIVATE R2 config: the five required names, no public base URL. */
function buildPrivateR2Config(
  overrides: Partial<StorageConfig> = {},
): StorageConfig {
  return buildStorageConfig({
    driver: 'r2',
    endpoint: FIXTURE_ENDPOINT,
    region: FIXTURE_REGION,
    bucket: FIXTURE_BUCKET,
    accessKeyId: FIXTURE_ACCESS_KEY_ID,
    secretAccessKey: FIXTURE_SECRET_ACCESS_KEY,
    publicBaseUrl: undefined,
    ...overrides,
  });
}

function buildAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 3000,
    publicBaseUrl: 'http://localhost:3000',
    storageRoot: '',
    corsOrigins: [],
    devToolsEnabled: false,
    ...overrides,
  };
}

function buildStorageConfig(
  overrides: Partial<StorageConfig> = {},
): StorageConfig {
  return {
    driver: 'local',
    endpoint: '',
    region: 'auto',
    bucket: '',
    accessKeyId: '',
    secretAccessKey: '',
    publicBaseUrl: '',
    ...overrides,
  };
}

async function buildService(
  appConfig: AppConfig,
  storageConfig: StorageConfig,
): Promise<StorageReadinessService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      StorageReadinessService,
      {
        provide: ConfigService,
        useValue: {
          get: (key: 'app' | 'storage') =>
            key === 'app' ? appConfig : storageConfig,
        },
      },
    ],
  }).compile();

  return module.get<StorageReadinessService>(StorageReadinessService);
}

/**
 * Phase 11, work units 11G-4 (original) and 11I-T1 (private-R2 readiness
 * regression coverage). `StorageReadinessService` never makes a network
 * call in either driver mode — `local` uses a synchronous `fs.stat` against
 * a real local directory (never a company-video path; always
 * `process.cwd()` or an obviously-fake path here), and `r2` never touches
 * the network at all, by design (see the service's own doc comment).
 */
describe('StorageReadinessService', () => {
  describe('local driver', () => {
    it('reports configPresent + ready true when STORAGE_ROOT is a real, readable directory', async () => {
      const service = await buildService(
        buildAppConfig({ storageRoot: process.cwd() }),
        buildStorageConfig({ driver: 'local' }),
      );

      expect(service.check()).toEqual({
        driver: 'local',
        configPresent: true,
        ready: true,
      });
    });

    it('reports configPresent true but ready false when STORAGE_ROOT is set but does not exist', async () => {
      const service = await buildService(
        buildAppConfig({
          storageRoot: '/definitely/not/a/real/path/for-11g-4-tests',
        }),
        buildStorageConfig({ driver: 'local' }),
      );

      expect(service.check()).toEqual({
        driver: 'local',
        configPresent: true,
        ready: false,
      });
    });

    it('reports configPresent + ready false when STORAGE_ROOT is unset (empty string)', async () => {
      const service = await buildService(
        buildAppConfig({ storageRoot: '' }),
        buildStorageConfig({ driver: 'local' }),
      );

      expect(service.check()).toEqual({
        driver: 'local',
        configPresent: false,
        ready: false,
      });
    });

    // Phase 11, work unit 11I-B1's documented decision: `local` mode omits
    // `publicDeliveryAvailable` entirely rather than reporting a hard-coded
    // `false`, because public object-storage delivery does not exist for
    // this driver. Asserted even with a stale `OBJECT_STORAGE_PUBLIC_BASE_URL`
    // left in the config, which must not conjure the field into existence.
    it('omits publicDeliveryAvailable entirely in local mode, even with a stale public base URL configured', async () => {
      const service = await buildService(
        buildAppConfig({ storageRoot: process.cwd() }),
        buildStorageConfig({
          driver: 'local',
          publicBaseUrl: FIXTURE_PUBLIC_BASE_URL,
        }),
      );

      const response = service.check();

      expect(Object.keys(response).sort()).toEqual([
        'configPresent',
        'driver',
        'ready',
      ]);
      expect('publicDeliveryAvailable' in response).toBe(false);
      expect(response.publicDeliveryAvailable).toBeUndefined();
    });
  });

  describe('r2 driver', () => {
    /**
     * Pins the canonical requirement list this service now derives from.
     * If a future change adds or removes a required R2 variable, this test
     * fails first and forces the readiness expectations below to be
     * re-checked deliberately rather than drifting silently — which is
     * exactly the failure mode work unit 11I-B1 exists to close.
     */
    it('derives readiness from env.validation.ts REQUIRED_R2_KEYS — exactly five names, NOT including OBJECT_STORAGE_PUBLIC_BASE_URL', () => {
      expect([...REQUIRED_R2_KEYS]).toEqual(
        REQUIRED_R2_FIELDS.map(({ requiredEnvVar }) => requiredEnvVar),
      );
      expect([...REQUIRED_R2_KEYS]).not.toContain(
        'OBJECT_STORAGE_PUBLIC_BASE_URL',
      );
    });

    it('reports configPresent + ready true for a PRIVATE bucket: the five required names set, no public base URL (no network call)', async () => {
      const service = await buildService(
        buildAppConfig(),
        buildPrivateR2Config(),
      );

      expect(service.check()).toEqual({
        driver: 'r2',
        configPresent: true,
        ready: true,
        publicDeliveryAvailable: false,
      });
    });

    /**
     * THE regression this work unit exists for. Before 11I-B1 this service
     * hard-coded a sixth requirement (`publicBaseUrl`), so a correctly
     * configured private deployment reported `ready: false` permanently.
     * Both "absent" spellings are covered: `undefined` (what
     * `configuration.ts` produces when `OBJECT_STORAGE_PUBLIC_BASE_URL` is
     * unset) and `''`/whitespace (what an emptied `.env` line produces).
     * Re-adding `OBJECT_STORAGE_PUBLIC_BASE_URL` to the readiness
     * requirement makes every case here fail.
     */
    it.each([
      ['undefined (variable unset)', undefined],
      ['an empty string', ''],
      ['a whitespace-only string', '   '],
    ])(
      'stays ready with the public base URL %s — it is NOT a readiness requirement',
      async (_label, publicBaseUrl) => {
        const service = await buildService(
          buildAppConfig(),
          buildPrivateR2Config({ publicBaseUrl }),
        );

        const response = service.check();

        expect(response.ready).toBe(true);
        expect(response.configPresent).toBe(true);
        expect(response.publicDeliveryAvailable).toBe(false);
      },
    );

    it('reports publicDeliveryAvailable true when OBJECT_STORAGE_PUBLIC_BASE_URL is configured', async () => {
      const service = await buildService(
        buildAppConfig(),
        buildPrivateR2Config({ publicBaseUrl: FIXTURE_PUBLIC_BASE_URL }),
      );

      expect(service.check()).toEqual({
        driver: 'r2',
        configPresent: true,
        ready: true,
        publicDeliveryAvailable: true,
      });
    });

    // Each of the five genuinely required variables, in both "missing"
    // spellings. `publicDeliveryAvailable` stays `true` throughout, proving
    // the two signals are independent axes: public delivery can be
    // configured while the deployment is not ready, and vice versa.
    it.each(
      REQUIRED_R2_FIELDS.flatMap(({ requiredEnvVar, blank }) =>
        BLANK_SPELLINGS.map(({ spelling, value }) => ({
          requiredEnvVar,
          spelling,
          missing: blank(value),
        })),
      ),
    )(
      'reports configPresent + ready false when $requiredEnvVar is $spelling',
      async ({ missing }) => {
        const service = await buildService(
          buildAppConfig(),
          buildPrivateR2Config({
            publicBaseUrl: FIXTURE_PUBLIC_BASE_URL,
            ...missing,
          }),
        );

        expect(service.check()).toEqual({
          driver: 'r2',
          configPresent: false,
          ready: false,
          publicDeliveryAvailable: true,
        });
      },
    );
  });

  describe('secret-free payload', () => {
    it('never leaks any OBJECT_STORAGE_* value or the STORAGE_ROOT path in r2 mode', async () => {
      const service = await buildService(
        buildAppConfig({ storageRoot: FIXTURE_STORAGE_ROOT }),
        buildPrivateR2Config({ publicBaseUrl: FIXTURE_PUBLIC_BASE_URL }),
      );

      const response = service.check();
      const serialized = JSON.stringify(response);

      // Sentinel assertions FIRST, deliberately: one sentinel is embedded
      // in every endpoint/region/bucket/access key/secret/public base
      // URL/STORAGE_ROOT fixture above, so if any of them ever reaches the
      // payload this is the assertion that reports it. Ordered ahead of the
      // key-set check so an ADDITIVE leak (a brand-new key carrying a
      // value) fails as a leak rather than as an unrelated shape mismatch.
      expect(serialized).not.toContain(SECRET_SENTINEL);
      expect(serialized).not.toContain(FIXTURE_ENDPOINT);
      expect(serialized).not.toContain(FIXTURE_BUCKET);
      expect(serialized).not.toContain(FIXTURE_ACCESS_KEY_ID);
      expect(serialized).not.toContain(FIXTURE_SECRET_ACCESS_KEY);
      expect(serialized).not.toContain(FIXTURE_PUBLIC_BASE_URL);
      expect(serialized).not.toContain(FIXTURE_STORAGE_ROOT);

      expect(Object.keys(response).sort()).toEqual([
        'configPresent',
        'driver',
        'publicDeliveryAvailable',
        'ready',
      ]);
    });

    it('never leaks the STORAGE_ROOT path (or a stale R2 value) in local mode', async () => {
      const service = await buildService(
        buildAppConfig({ storageRoot: FIXTURE_STORAGE_ROOT }),
        buildStorageConfig({
          driver: 'local',
          endpoint: FIXTURE_ENDPOINT,
          region: FIXTURE_REGION,
          bucket: FIXTURE_BUCKET,
          accessKeyId: FIXTURE_ACCESS_KEY_ID,
          secretAccessKey: FIXTURE_SECRET_ACCESS_KEY,
          publicBaseUrl: FIXTURE_PUBLIC_BASE_URL,
        }),
      );

      const serialized = JSON.stringify(service.check());

      expect(serialized).not.toContain(SECRET_SENTINEL);
      expect(serialized).not.toContain(FIXTURE_STORAGE_ROOT);
    });
  });
});
