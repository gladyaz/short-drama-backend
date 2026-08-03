import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

interface AdsConfigBody {
  enabled: boolean;
  minVideosBetweenAds: number;
  maxVideosBetweenAds: number;
  minSecondsBetweenAds: number;
  graceVideos: number;
}

/**
 * Phase 15A, slice 15A-S1 (control workspace `DECISIONS.md`, "2026-08-03 —
 * Phase 15A slice S1 APPROVED...", commit `0f75033`). e2e coverage for the
 * new public `GET /config/ads` route.
 *
 * The five `ADS_*` env vars are read once at `AdsConfigModule` bootstrap
 * (`AdsConfigService`'s constructor), so — matching the pattern in
 * `test/health.e2e-spec.ts` — they are cleared BEFORE
 * `Test.createTestingModule(...).compile()` so this suite exercises the
 * documented DEFAULT posture deterministically. `delete` (not `''`) is used
 * here deliberately, unlike `test/health.e2e-spec.ts`'s `STORAGE_DRIVER`/
 * `DEV_TOOLS_ENABLED` fixtures: those are pre-existing vars a developer's
 * real local `.env` may already set, so `ConfigModule` re-running dotenv on
 * every app boot (which only skips keys ALREADY present in `process.env`)
 * could repopulate a deleted one. `ADS_*` are brand new in this slice — no
 * developer's existing `.env` can already contain them — so `delete` gives
 * the true "unset" posture the frozen contract's `enabled` default
 * (`unset -> true`, silently, vs. `'' -> true` + a warn) actually depends on.
 */
describe('Ads config (e2e)', () => {
  const ADS_ENV_KEYS = [
    'ADS_INTERSTITIAL_ENABLED',
    'ADS_MIN_VIDEOS_BETWEEN_ADS',
    'ADS_MAX_VIDEOS_BETWEEN_ADS',
    'ADS_MIN_SECONDS_BETWEEN_ADS',
    'ADS_GRACE_VIDEOS',
  ] as const;

  let app: INestApplication<App>;
  const previousEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    for (const key of ADS_ENV_KEYS) {
      previousEnv.set(key, process.env[key]);
      delete process.env[key];
    }

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    try {
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

  it('GET /config/ads returns 200, unauthenticated, with exactly the frozen five-field default shape', async () => {
    const response = await request(app.getHttpServer())
      .get('/config/ads')
      .expect(HttpStatus.OK);

    const body = response.body as AdsConfigBody;

    expect(body).toEqual({
      enabled: true,
      minVideosBetweenAds: 3,
      maxVideosBetweenAds: 6,
      minSecondsBetweenAds: 120,
      graceVideos: 5,
    });

    // No envelope, no extra keys riding along — exactly these five.
    expect(Object.keys(body).sort()).toEqual([
      'enabled',
      'graceVideos',
      'maxVideosBetweenAds',
      'minSecondsBetweenAds',
      'minVideosBetweenAds',
    ]);
  });

  it('requires no Authorization header at all', async () => {
    await request(app.getHttpServer())
      .get('/config/ads')
      .unset('Authorization')
      .expect(HttpStatus.OK);
  });
});
