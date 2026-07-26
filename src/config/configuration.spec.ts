import configuration, { DEFAULT_STORAGE_DRIVER } from './configuration';

/**
 * Phase 11, work unit 11G-3: unit coverage for the `STORAGE_DRIVER`
 * resolution added to the config factory. Entirely in-memory — sets/restores
 * `process.env.STORAGE_DRIVER` around each test, makes no network call, and
 * never touches real credentials.
 */
describe('configuration — storage.driver (Phase 11, 11G-3)', () => {
  const originalStorageDriver = process.env.STORAGE_DRIVER;

  afterEach(() => {
    if (originalStorageDriver === undefined) {
      delete process.env.STORAGE_DRIVER;
    } else {
      process.env.STORAGE_DRIVER = originalStorageDriver;
    }
  });

  it('resolves storage.driver to "local" (the default) when STORAGE_DRIVER is unset', () => {
    delete process.env.STORAGE_DRIVER;

    expect(configuration().storage.driver).toBe(DEFAULT_STORAGE_DRIVER);
    expect(configuration().storage.driver).toBe('local');
  });

  it('resolves storage.driver to "local" when STORAGE_DRIVER is empty', () => {
    process.env.STORAGE_DRIVER = '';

    expect(configuration().storage.driver).toBe('local');
  });

  it('resolves storage.driver to "r2" when STORAGE_DRIVER=r2', () => {
    process.env.STORAGE_DRIVER = 'r2';

    expect(configuration().storage.driver).toBe('r2');
  });
});
