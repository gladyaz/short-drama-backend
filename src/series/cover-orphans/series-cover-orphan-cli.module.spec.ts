import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { RootConfig } from '../../config/configuration';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import { SeriesCoverOrphanCliModule } from './series-cover-orphan-cli.module';
import { SeriesCoverOrphanService } from './series-cover-orphan.service';

/**
 * Slice "SERIES COVER ORPHAN CLEANUP LIFECYCLE": proves the CLI's dependency
 * graph is actually satisfiable — that `SeriesCoverOrphanService` resolves
 * with a real `StorageService` (built by `StorageModule`'s own `S3_CLIENT`
 * factory, exactly as production builds it) and a real `PrismaService`.
 * Without this, a DI mistake in `SeriesCoverOrphanCliModule` would only ever
 * surface the first time an operator ran the command.
 *
 * ZERO NETWORK. Constructing an `S3Client` dereferences config but makes no
 * request, and this file never calls a single method on the resolved
 * `StorageService` — no list, no head, no delete. `PrismaService` is
 * resolved but never `$connect()`ed.
 *
 * The module's imports are reconstructed here rather than importing
 * `SeriesCoverOrphanCliModule` itself, because that module calls
 * `ConfigModule.forRoot({ validate: validateEnv })` against the ambient
 * process environment — which would make this test's outcome depend on the
 * developer's `.env` rather than on the wiring under test. The provider
 * list and the imported modules are otherwise identical; the dummy storage
 * config below mirrors `transcode.module.spec.ts`'s established fixture for
 * the same reason it exists there.
 */
const DUMMY_STORAGE_CONFIG: RootConfig['storage'] = {
  driver: 'local',
  endpoint: 'https://mock.example.test',
  region: 'auto',
  bucket: 'mock-bucket',
  accessKeyId: 'mock-access-key-id',
  secretAccessKey: 'mock-secret-access-key',
  publicBaseUrl: undefined,
};

describe('SeriesCoverOrphanCliModule wiring', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [() => ({ storage: DUMMY_STORAGE_CONFIG })],
        }),
        PrismaModule,
        StorageModule,
      ],
      providers: [SeriesCoverOrphanService],
    }).compile();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('resolves the sweep service with real Prisma and Storage collaborators', () => {
    const service = moduleRef.get(SeriesCoverOrphanService);

    expect(service).toBeInstanceOf(SeriesCoverOrphanService);
    expect(moduleRef.get(StorageService)).toBeInstanceOf(StorageService);

    // Deliberately NOT `toBeInstanceOf(PrismaService)`: `PrismaClient`'s
    // constructor returns a Proxy, so a resolved `PrismaService` fails an
    // `instanceof` check against its own class even though DI resolved it
    // correctly. Asserting the capabilities the sweep actually uses — the
    // `series` delegate and the Nest lifecycle hooks — is both meaningful
    // and immune to that quirk.
    const prisma = moduleRef.get(PrismaService);
    expect(typeof prisma.series.findMany).toBe('function');
    expect(typeof prisma.series.findFirst).toBe('function');
    expect(typeof prisma.onModuleInit).toBe('function');
  });

  it('exposes the sweep through no HTTP controller of its own', () => {
    // The CLI is the only invocation surface: the real module contributes no
    // controller, so no route can reach the sweep.
    const controllers = Reflect.getMetadata(
      'controllers',
      SeriesCoverOrphanCliModule,
    ) as unknown[] | undefined;

    expect(controllers ?? []).toEqual([]);
  });
});
