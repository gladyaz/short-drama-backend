import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { RootConfig } from '../../config/configuration';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import { HlsDemoteCliModule } from './hls-demote-cli.module';
import { HlsDemoteService } from './hls-demote.service';

/**
 * Work unit "HLS DEMOTE": proves the CLI's dependency graph is actually
 * satisfiable, following `series-cover-orphan-cli.module.spec.ts` exactly —
 * including WHY the module's imports are reconstructed here rather than
 * importing `HlsDemoteCliModule` itself (that module calls
 * `ConfigModule.forRoot({ validate: validateEnv })` against the ambient
 * process environment, which would make this test's outcome depend on the
 * developer's `.env` rather than on the wiring under test).
 *
 * ZERO NETWORK: constructing an `S3Client` dereferences config but makes no
 * request, and this file never calls a method on the resolved
 * `StorageService`.
 */
const DUMMY_STORAGE_CONFIG: RootConfig['storage'] = {
  driver: 'local',
  endpoint: 'https://mock.example.test',
  region: 'auto',
  bucket: 'mock-bucket',
  accessKeyId: 'mock-access-key-id',
  secretAccessKey: 'mock-secret-access-key',
  publicBaseUrl: undefined,
  localRoot: '/tmp/local-objects.test',
};

describe('HlsDemoteCliModule wiring', () => {
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
      providers: [HlsDemoteService],
    }).compile();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('resolves the demote service with real Prisma and Storage collaborators', () => {
    const service = moduleRef.get(HlsDemoteService);

    expect(service).toBeInstanceOf(HlsDemoteService);
    expect(moduleRef.get(StorageService)).toBeInstanceOf(StorageService);

    // Deliberately NOT `toBeInstanceOf(PrismaService)` — `PrismaClient`'s
    // constructor returns a Proxy, so a resolved `PrismaService` fails an
    // `instanceof` check against its own class (same note as
    // `series-cover-orphan-cli.module.spec.ts`).
    const prisma = moduleRef.get(PrismaService);
    expect(typeof prisma.video.findUnique).toBe('function');
    expect(typeof prisma.video.updateMany).toBe('function');
  });

  it('exposes the demotion through no HTTP controller of its own', () => {
    const controllers = Reflect.getMetadata(
      'controllers',
      HlsDemoteCliModule,
    ) as unknown[] | undefined;

    expect(controllers ?? []).toEqual([]);
  });

  it('does not import TranscodeModule — demotion must work with TRANSCODE_ENABLED off', () => {
    const imports = (Reflect.getMetadata('imports', HlsDemoteCliModule) ??
      []) as { name?: string }[];

    expect(imports.map((imported) => imported?.name)).not.toContain(
      'TranscodeModule',
    );
  });
});
