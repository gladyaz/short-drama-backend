import { PrismaModule } from '../prisma/prisma.module';
import { TranscodeModule } from '../transcode/transcode.module';
import { WorkerModule } from './worker.module';

/**
 * Fix cycle 1 regression coverage (Slice 11P HIGH finding): proves
 * `WorkerModule.register()`'s import graph is gated on `TRANSCODE_ENABLED`
 * BEFORE the module is ever compiled/booted — i.e. this is a pure,
 * synchronous assertion on the `DynamicModule` metadata `register()`
 * returns, not a `Test.createTestingModule(...).compile()`/`.init()` run.
 * That distinction matters here: `PrismaModule` is `@Global()` and
 * `PrismaService.onModuleInit` (which calls `$connect()`) only runs when
 * Nest actually INITIALIZES a module graph that contains it — so the
 * regression this guards against ("PrismaModule silently creeps back into
 * the flag-off import array, making `$connect()` fire unconditionally on
 * every worker boot") is fully captured by asserting on the `imports` array
 * itself, without needing to spin up ffmpeg/config/`.env` machinery the way
 * a full compile of `WorkerModule.register()` would (see `main.spec.ts`'s
 * doc comment for why this file avoids that same coupling).
 */
describe('WorkerModule.register() — TRANSCODE_ENABLED module-graph gate', () => {
  const originalTranscodeEnabled = process.env.TRANSCODE_ENABLED;
  const originalRedisUrl = process.env.REDIS_URL;

  afterEach(() => {
    if (originalTranscodeEnabled === undefined) {
      delete process.env.TRANSCODE_ENABLED;
    } else {
      process.env.TRANSCODE_ENABLED = originalTranscodeEnabled;
    }
    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = originalRedisUrl;
    }
  });

  it("excludes PrismaModule and TranscodeModule when TRANSCODE_ENABLED is unset (this repo's only shipped default)", () => {
    delete process.env.TRANSCODE_ENABLED;

    const dynamicModule = WorkerModule.register();

    expect(dynamicModule.imports).not.toContain(PrismaModule);
    expect(dynamicModule.imports).not.toContain(TranscodeModule);
  });

  it('excludes PrismaModule and TranscodeModule when TRANSCODE_ENABLED=false', () => {
    process.env.TRANSCODE_ENABLED = 'false';

    const dynamicModule = WorkerModule.register();

    expect(dynamicModule.imports).not.toContain(PrismaModule);
    expect(dynamicModule.imports).not.toContain(TranscodeModule);
  });

  it('excludes PrismaModule and TranscodeModule for any non-"true" value (mirrors the exact-string check in configuration.ts)', () => {
    process.env.TRANSCODE_ENABLED = 'TRUE';

    const dynamicModule = WorkerModule.register();

    expect(dynamicModule.imports).not.toContain(PrismaModule);
    expect(dynamicModule.imports).not.toContain(TranscodeModule);
  });

  it('includes PrismaModule and TranscodeModule when TRANSCODE_ENABLED=true (flag-on persistent-worker wiring is preserved)', () => {
    process.env.TRANSCODE_ENABLED = 'true';
    // `register()` still builds a `ConfigModule.forRoot({ validate:
    // validateEnv })` entry in its `imports` array, and `@nestjs/config`
    // runs that `validate` call eagerly (not deferred to Nest bootstrap) —
    // so REDIS_URL must be present here purely to satisfy
    // `validateTranscodeConfig`'s shape check (no network call is ever made
    // by that check, and nothing in this test awaits/boots the module).
    process.env.REDIS_URL = 'redis://localhost:6379';

    const dynamicModule = WorkerModule.register();

    expect(dynamicModule.imports).toContain(PrismaModule);
    expect(dynamicModule.imports).toContain(TranscodeModule);
  });
});
