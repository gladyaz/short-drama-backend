import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AppConfig, StorageConfig } from '../config/configuration';
import { StorageReadinessService } from './storage-readiness.service';

/** Real R2-shaped secret strings, used only to assert they never leak into the response. */
const FIXTURE_ENDPOINT = 'https://fixture-account.r2.cloudflarestorage.com';
const FIXTURE_BUCKET = 'fixture-bucket-name';
const FIXTURE_REGION = 'auto';
const FIXTURE_ACCESS_KEY_ID = 'fixture-access-key-id';
const FIXTURE_SECRET_ACCESS_KEY = 'fixture-secret-access-key';
const FIXTURE_PUBLIC_BASE_URL = 'https://fixture-media.example.test';

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
 * Phase 11, work unit 11G-4. `StorageReadinessService` never makes a
 * network call in either driver mode — `local` uses a synchronous `fs.stat`
 * against a real local directory (never a company-video path; always
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
  });

  describe('r2 driver', () => {
    it('reports configPresent + ready true when every OBJECT_STORAGE_* name is set (no network call)', async () => {
      const service = await buildService(
        buildAppConfig(),
        buildStorageConfig({
          driver: 'r2',
          endpoint: FIXTURE_ENDPOINT,
          region: FIXTURE_REGION,
          bucket: FIXTURE_BUCKET,
          accessKeyId: FIXTURE_ACCESS_KEY_ID,
          secretAccessKey: FIXTURE_SECRET_ACCESS_KEY,
          publicBaseUrl: FIXTURE_PUBLIC_BASE_URL,
        }),
      );

      expect(service.check()).toEqual({
        driver: 'r2',
        configPresent: true,
        ready: true,
      });
    });

    it.each([
      ['endpoint', { endpoint: '' }],
      ['region', { region: '' }],
      ['bucket', { bucket: '' }],
      ['accessKeyId', { accessKeyId: '' }],
      ['secretAccessKey', { secretAccessKey: '' }],
      ['publicBaseUrl', { publicBaseUrl: '' }],
    ])(
      'reports configPresent + ready false when %s is missing',
      async (_label, missing) => {
        const service = await buildService(
          buildAppConfig(),
          buildStorageConfig({
            driver: 'r2',
            endpoint: FIXTURE_ENDPOINT,
            region: FIXTURE_REGION,
            bucket: FIXTURE_BUCKET,
            accessKeyId: FIXTURE_ACCESS_KEY_ID,
            secretAccessKey: FIXTURE_SECRET_ACCESS_KEY,
            publicBaseUrl: FIXTURE_PUBLIC_BASE_URL,
            ...missing,
          }),
        );

        expect(service.check()).toEqual({
          driver: 'r2',
          configPresent: false,
          ready: false,
        });
      },
    );
  });

  describe('secret-free payload', () => {
    it('never includes the endpoint, bucket, region, access key, secret, public base URL, or STORAGE_ROOT path in the response', async () => {
      const service = await buildService(
        buildAppConfig({ storageRoot: '/some/absolute/company-storage/path' }),
        buildStorageConfig({
          driver: 'r2',
          endpoint: FIXTURE_ENDPOINT,
          region: FIXTURE_REGION,
          bucket: FIXTURE_BUCKET,
          accessKeyId: FIXTURE_ACCESS_KEY_ID,
          secretAccessKey: FIXTURE_SECRET_ACCESS_KEY,
          publicBaseUrl: FIXTURE_PUBLIC_BASE_URL,
        }),
      );

      const response = service.check();
      const serialized = JSON.stringify(response);

      expect(Object.keys(response).sort()).toEqual([
        'configPresent',
        'driver',
        'ready',
      ]);
      expect(serialized).not.toContain(FIXTURE_ENDPOINT);
      expect(serialized).not.toContain(FIXTURE_BUCKET);
      expect(serialized).not.toContain(FIXTURE_ACCESS_KEY_ID);
      expect(serialized).not.toContain(FIXTURE_SECRET_ACCESS_KEY);
      expect(serialized).not.toContain(FIXTURE_PUBLIC_BASE_URL);
      expect(serialized).not.toContain('/some/absolute/company-storage/path');
    });
  });
});
