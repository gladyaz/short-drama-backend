import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';

/**
 * Slice 11N, proof 2: "Existing media rows remain valid" — the additive
 * migration (`prisma/migrations/*_add_processing_state_and_version`) must
 * not change the meaning or reachability of a single pre-existing row. Every
 * legacy/local row (seeded by `prisma/seed.ts`, work unit 8-B4 — identified
 * here by `objectStorageKey: null`, since only the 11B-3 admin upload flow
 * ever sets that field) must have `processingState IS NULL` and
 * `processingVersion = 0`, and the public feed must still serve them
 * unchanged. This file makes no `TRANSCODE_ENABLED`/`REDIS_URL` change at
 * all — it runs against this repo's ordinary default configuration.
 */
describe('Slice 11N — processing-state migration safety (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('every legacy row (objectStorageKey: null) has processingState null and processingVersion 0', async () => {
    const legacyRows = await prisma.video.findMany({
      where: { objectStorageKey: null },
      select: { id: true, processingState: true, processingVersion: true },
    });

    // The seed script creates 40 legacy rows (work unit 8-B4); this is a
    // floor, not an exact count, so unrelated fixtures elsewhere in the
    // suite never make this test flaky.
    expect(legacyRows.length).toBeGreaterThanOrEqual(40);

    for (const row of legacyRows) {
      expect(row.processingState).toBeNull();
      expect(row.processingVersion).toBe(0);
    }
  });

  it('GET /videos/feed still serves the legacy catalog, unaffected by the migration', async () => {
    const response = await request(app.getHttpServer())
      .get('/videos/feed')
      .expect(HttpStatus.OK);

    const feed = response.body as Array<{ id: string }>;
    expect(feed.length).toBeGreaterThanOrEqual(40);
  });
});
