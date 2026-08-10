import { existsSync, readFileSync } from 'fs';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { ConfigService } from '@nestjs/config';
import {
  config as loadEnvFileIntoProcessEnv,
  parse as parseEnvFileText,
} from 'dotenv';
import type { RootConfig, StorageConfig } from '../../config/configuration';
import { REQUIRED_R2_KEYS } from '../../config/env.validation';
import { redactSensitiveText } from '../../common/logging/redact';
import { StorageService } from '../../storage/storage.service';
import { FfmpegAvailabilityCliClient } from './ffmpeg-availability-cli.client';
import { HlsEncoderCliClient } from './hls-encoder-cli.client';
import { HlsPackageValidator } from './hls-package-validator.service';
import { HlsProbeCliClient } from './hls-probe-cli.client';
import { HlsSmokeRunner } from './hls-smoke-runner.service';
import { HlsSyntheticGeneratorCliClient } from './hls-synthetic-generator-cli.client';
import { HlsTranscodeService } from './hls-transcode.service';
import { HLS_SMOKE_KEY_PREFIX } from './hls.constants';
import { MasterPlaylistService } from './master-playlist.service';
import { SyntheticSourceService } from './synthetic-source.service';

/**
 * Slice 11O — the OPT-IN, REAL-NETWORK gated proof of the HLS worker
 * pipeline against the private development R2 bucket. Mirrors slice 11K's
 * pattern (`../storage/storage-r2-media-smoke.spec.ts`) exactly: gated
 * behind an explicit, command-line-ONLY opt-in flag, an anti-silent-skip
 * integrity guard that ALWAYS runs, and pre-flight bucket/endpoint checks
 * before any write.
 *
 * Approved by `DECISIONS.md`, "2026-08-10 — Slice 11O APPROVED": "Real-R2
 * proof: EXACTLY ONE gated run, only after implementation commit + reviewer
 * APPROVED + pre-flight (bucket identity/endpoint shape) passes; unique
 * disposable prefix `_r2-hls-smoke-tests/<unique>/` — never a production
 * namespace". **DO NOT RUN THIS SPEC** — per the work unit's own scope, the
 * ONE real-R2 execution happens AFTER independent review and the
 * implementation commit, run by the orchestrator, not by this implementer
 * session.
 *
 * ## Gate
 *
 * The full-pipeline suite runs only when ALL of:
 *   1. `RUN_R2_HLS_SMOKE === '1'`,
 *   2. that flag is NOT declared in the `.env` file (enforced, not merely
 *      documented — see `isOptInDeclaredInEnvFile` below, identical
 *      rationale to 11K's own guard), and
 *   3. every name in `env.validation.ts`'s `REQUIRED_R2_KEYS` is present.
 *
 * Otherwise the suite is `describe.skip`ped and ZERO network calls are
 * made — no `S3Client`, no `StorageService`, no `HlsSmokeRunner` is ever
 * constructed; the describe callback only builds a key-prefix-shaped label.
 *
 * ## Anti-silent-skip
 *
 * A second `describe` below NEVER skips. Opting in with an incomplete
 * configuration FAILS loudly (naming the missing variables, never their
 * values) instead of quietly passing green while the real proof never runs.
 *
 * ## Exact run command (for the orchestrator)
 *
 * ```
 * set -a; . ./.env; set +a
 * RUN_R2_HLS_SMOKE=1 npx jest src/transcode/hls/hls-r2-smoke.spec.ts
 * ```
 *
 * The `set -a; . ./.env; set +a` step matters: per `TASK_QUEUE.md`'s
 * "Silent-skip trap" note, `RUN_R2_HLS_SMOKE=1 npm test` alone does NOT
 * export the five `OBJECT_STORAGE_*` values into the child process unless
 * they are separately exported into the shell first — sourcing `.env` with
 * `set -a` (auto-export) before invoking `jest` is what makes them visible
 * to `process.env` inside the gate check. `RUN_R2_HLS_SMOKE` itself must
 * come from the command line, per the anti-silent-skip guard below — do NOT
 * add it to `.env`.
 */

/**
 * True when the opt-in flag is declared, with any non-empty value, in the
 * `.env` file on disk — checked BEFORE `.env` is loaded, so a poisoned
 * `.env` can never talk this file into injecting real R2 credentials into
 * `process.env` on an ordinary `npm test` run. Identical rationale and
 * implementation to
 * `../storage/storage-r2-media-smoke.spec.ts::isOptInDeclaredInEnvFile`
 * (kept as a separate copy, scoped to `RUN_R2_HLS_SMOKE`, rather than a
 * shared export, so this file's gate cannot be affected by a future change
 * to the unrelated 11K flag's checker).
 */
function isOptInDeclaredInEnvFile(): boolean {
  try {
    if (!existsSync('.env')) {
      return false;
    }

    const declaredValue: string | undefined = parseEnvFileText(
      readFileSync('.env', 'utf8'),
    ).RUN_R2_HLS_SMOKE;

    return declaredValue !== undefined && declaredValue !== '';
  } catch {
    return false;
  }
}

const declaredInEnvFile = isOptInDeclaredInEnvFile();

if (process.env.RUN_R2_HLS_SMOKE === '1' && !declaredInEnvFile) {
  loadEnvFileIntoProcessEnv();
}

const isOptedIn = process.env.RUN_R2_HLS_SMOKE === '1';

const missingR2Keys: string[] = REQUIRED_R2_KEYS.filter(
  (key) => !process.env[key],
);

const gateResolved =
  isOptedIn && !declaredInEnvFile && missingR2Keys.length === 0;

const maybeDescribe = gateResolved ? describe : describe.skip;

/** Generous ceiling: real synthetic-source generation + 4-rung transcode + ~17 R2 round trips + cleanup verification. */
const NETWORK_TEST_TIMEOUT_MS = 300_000;

describe('HLS R2 smoke test — opt-in integrity guard (always runs)', () => {
  it('does not silently skip when RUN_R2_HLS_SMOKE=1', () => {
    if (!isOptedIn) {
      expect(maybeDescribe).toBe(describe.skip);
      return;
    }

    expect(missingR2Keys).toEqual([]);
    expect(gateResolved).toBe(true);
  });

  it('refuses an opt-in declared in the .env file instead of on the command line', () => {
    if (declaredInEnvFile) {
      throw new Error(
        'RUN_R2_HLS_SMOKE is declared with a value inside the .env file. ' +
          'This slice opts in from the COMMAND LINE ONLY — e.g. ' +
          '`RUN_R2_HLS_SMOKE=1 npx jest src/transcode/hls/hls-r2-smoke.spec.ts` ' +
          '— and never from .env. Remove the line from .env and pass the ' +
          'variable on the command line instead. (The full-pipeline suite ' +
          'is already blocked regardless: gateResolved AND-s in ' +
          '!declaredInEnvFile.)',
      );
    }

    expect(declaredInEnvFile).toBe(false);
  });
});

maybeDescribe(
  'HLS worker pipeline — gated real-R2 proof (real network, opt-in only via RUN_R2_HLS_SMOKE=1 + real creds)',
  () => {
    let runner: HlsSmokeRunner;

    beforeAll(async () => {
      // --- Pre-flight 1: endpoint shape (mirrors env.validation.ts's own
      //     shape-only check — no DNS resolution, no connection).
      const endpoint = process.env.OBJECT_STORAGE_ENDPOINT!;
      let parsedEndpoint: URL;
      try {
        parsedEndpoint = new URL(endpoint);
      } catch {
        throw new Error('OBJECT_STORAGE_ENDPOINT is not a valid absolute URL.');
      }
      if (
        parsedEndpoint.protocol !== 'http:' &&
        parsedEndpoint.protocol !== 'https:'
      ) {
        throw new Error('OBJECT_STORAGE_ENDPOINT must use http/https.');
      }

      const client = new S3Client({
        region: process.env.OBJECT_STORAGE_REGION,
        endpoint,
        forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID!,
          secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY!,
        },
      });

      const bucket = process.env.OBJECT_STORAGE_BUCKET!;

      // --- Pre-flight 2: bucket identity — confirm the configured bucket is
      //     the one this run will actually touch, BEFORE any write, via a
      //     read-only HeadBucket call (existence/access only — no object is
      //     written or listed by this call).
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (error) {
        throw new Error(
          redactSensitiveText(
            `Pre-flight HeadBucket failed for the configured OBJECT_STORAGE_BUCKET — refusing to proceed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }

      const storageService = createStorageServiceFromEnv(client);

      runner = new HlsSmokeRunner(
        new SyntheticSourceService(
          new HlsSyntheticGeneratorCliClient(),
          new HlsProbeCliClient(),
        ),
        new HlsTranscodeService(new HlsEncoderCliClient()),
        new MasterPlaylistService(),
        new HlsPackageValidator(new HlsProbeCliClient()),
        storageService,
      );

      // Belt-and-suspenders: confirm ffmpeg is actually present before
      // attempting a real transcode (a clear failure here beats an opaque
      // ENOENT deep inside the pipeline).
      const availability = await new FfmpegAvailabilityCliClient().check();
      if (!availability.ffmpegAvailable || !availability.ffprobeAvailable) {
        throw new Error(
          'ffmpeg/ffprobe are not available on PATH — the gated real-R2 ' +
            'proof requires a real local transcode before any upload.',
        );
      }
    }, 30_000);

    it(
      'runs the full local pipeline, uploads under a fresh unique prefix, verifies every object, and proves cleanup',
      async () => {
        const result = await runner.run({ upload: true });

        // Local validation must have passed (upload only ever happens after
        // this — see HlsSmokeRunner's own guard).
        expect(result.validation.valid).toBe(true);
        expect(result.validation.issues).toEqual([]);
        expect(result.rungArtifacts.length).toBeGreaterThanOrEqual(1);

        expect(result.upload).toBeDefined();
        expect(result.upload!.keyPrefix.startsWith(HLS_SMOKE_KEY_PREFIX)).toBe(
          true,
        );
        expect(result.upload!.uploadedObjects.length).toBeGreaterThan(0);
        expect(result.upload!.verified).toBe(true);

        // The BINDING cleanup proof (approval item 10): every recorded
        // uploaded key was deleted AND HEAD-verified gone.
        expect(result.upload!.cleanedUp).toBe(true);
        expect(result.upload!.cleanupIssues).toEqual([]);
      },
      NETWORK_TEST_TIMEOUT_MS,
    );
  },
);

/**
 * Builds a REAL `StorageService` directly from `process.env`, mirroring
 * `../storage/storage-r2-media-smoke.spec.ts::createStorageServiceFromEnv`
 * exactly — exercises the SAME `putObject`/`headObject`/`deleteObject` code
 * the app uses. Only ever called from `beforeAll` inside the gated suite.
 */
function createStorageServiceFromEnv(client: S3Client): StorageService {
  const storageConfig: StorageConfig = {
    driver: 'r2',
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT!,
    region: process.env.OBJECT_STORAGE_REGION!,
    bucket: process.env.OBJECT_STORAGE_BUCKET!,
    accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID!,
    secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY!,
    publicBaseUrl: undefined,
  };

  const configService = {
    get: (key: string): StorageConfig | undefined =>
      key === 'storage' ? storageConfig : undefined,
  } as unknown as ConfigService<RootConfig>;

  return new StorageService(configService, client);
}
