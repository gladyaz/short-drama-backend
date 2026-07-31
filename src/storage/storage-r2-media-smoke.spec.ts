import { createHash, randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { ConfigService } from '@nestjs/config';
import {
  config as loadEnvFileIntoProcessEnv,
  parse as parseEnvFileText,
} from 'dotenv';
import type { RootConfig, StorageConfig } from '../config/configuration';
import { REQUIRED_R2_KEYS } from '../config/env.validation';
import {
  MEDIA_SMOKE_CONTENT_TYPE,
  MEDIA_SMOKE_KEY_PREFIX,
  SYNTHETIC_MP4_MAX_DURATION_SECONDS,
  SYNTHETIC_MP4_MIN_DURATION_SECONDS,
  createTempDir,
  fetchSigned,
  generateSyntheticMp4,
  isMp4FamilyFormat,
  probeMp4,
  removeTempDir,
} from './storage-r2-media-smoke.helpers';
import { StorageService } from './storage.service';

/**
 * Phase 11, slice 11K (work unit 11K-B3). OPT-IN, REAL-NETWORK presigned
 * MP4 round-trip against the private development R2 bucket.
 *
 * Approved by `DECISIONS.md`, "Slice 11K approved + explicit Phase 12
 * sequencing EXCEPTION": one synthetic disposable MP4, one object under
 * `_r2-media-smoke-tests/`, private bucket only, no company media, no
 * multipart, no public/`r2.dev`/custom-domain delivery.
 *
 * ## Gate
 *
 * The round-trip suite runs only when ALL THREE hold:
 *   1. `RUN_R2_MEDIA_SMOKE === '1'`,
 *   2. that flag is NOT declared in the `.env` file (see below), and
 *   3. every name in `env.validation.ts`'s `REQUIRED_R2_KEYS` is present.
 *
 * Otherwise the suite is `describe.skip`ped and **zero network calls are
 * made**: no `S3Client` is constructed, no `StorageService` exists, no
 * `fetch` runs. Everything that touches the network lives inside
 * `beforeAll`/`it`, which Jest never executes for a skipped block — the
 * describe callback itself only builds a key string.
 *
 * ## Anti-silent-skip
 *
 * A second `describe` below is NEVER skipped. Opting in with an incomplete
 * configuration makes it FAIL (naming the missing variables, never their
 * values) instead of quietly passing green while the real work is skipped.
 *
 * ## `.env` (command-line opt-in, ENFORCED)
 *
 * **`RUN_R2_MEDIA_SMOKE=1` must be passed on the command line and must
 * never be written into `.env`.** That is enforced here, not merely
 * documented.
 *
 * Jest shares one `process.env` per worker, and other specs transitively
 * load `.env` into it (`@prisma/client` does so on import), so a flag left
 * in `.env` would be observable here even without the opt-in-only
 * `config()` call below. Because `.env` also holds the five
 * `OBJECT_STORAGE_*` values, the gate would then resolve on its own and an
 * ordinary `npm test` would fire a real R2 round trip, creating and
 * deleting an object nobody intended.
 *
 * So `.env` is read as TEXT before the gate and any non-empty
 * `RUN_R2_MEDIA_SMOKE` declaration found there both FAILS the
 * always-running guard below and forces `gateResolved` to false — the gate
 * fails CLOSED. That text is handed to `dotenv.parse` — the same grammar
 * `dotenv` itself applies, so the check cannot under-match a form `dotenv`
 * accepts — and immediately discarded: `parse()` writes nothing to
 * `process.env` (unlike `config()`), and the parsed object is never stored,
 * logged, thrown, or asserted on. A missing or unreadable `.env` is treated
 * as "not declared" and never throws — a file this process cannot read is
 * also a file `dotenv` and `@prisma/client` cannot read an opt-in out of.
 *
 * Injecting `.env` into `process.env` still happens ONLY on the opt-in
 * path, so a normal `npm test` never loads real R2 credentials through this
 * file.
 *
 * ## Leakage protection (binding)
 *
 * A presigned URL carries `X-Amz-Credential` and `X-Amz-Signature` in its
 * query string and the account id in its host. No `expect()` in this file
 * ever receives a signed URL — expiry is asserted on the `expiresAt`
 * TIMESTAMP and on the `X-Amz-Expires` parameter VALUE extracted out of the
 * URL (the non-secret constant `60`), never on the URL itself — every
 * signed request goes through `fetchSigned` (redirects rejected,
 * failed-response bodies never read, errors carrying only
 * method/status/key-prefix), and nothing is `console.log`ged.
 */

/**
 * True when the opt-in flag is declared, with any non-empty value, in the
 * `.env` file on disk.
 *
 * Resolved relative to `process.cwd()` — the exact same path `dotenv` and
 * `@prisma/client` resolve — so this inspects the file that could actually
 * poison `process.env`, not some other `.env`.
 *
 * ## Why `dotenv.parse`, not a regex
 *
 * An earlier version hand-transcribed `dotenv`'s own line grammar into a
 * regex and got it wrong in two places, each of which failed OPEN: the
 * grammar allows BACKTICK quoting (`` =`1` ``) as well as `'` and `"`, and
 * it accepts `KEY: value` as well as `KEY=value`. Asking `dotenv` itself
 * removes the whole class of bug — this detector is now definitionally in
 * sync with whatever `dotenv` accepts and cannot drift when it changes.
 *
 * `parse()` is pure: unlike `config()` it returns an object and writes
 * NOTHING to `process.env` (verified empirically over the full fuzz matrix
 * for the installed dotenv 17.4.2). Importing the module has no side
 * effects either — only the `config()` call below reads `.env` into the
 * process.
 *
 * ## Why non-empty rather than `=== '1'`
 *
 * Any value at all is a violation of the command-line-only rule, and the
 * safe direction is to over-match: over-matching fails the guard and tells
 * a human to take the line out of `.env`, while under-matching fails OPEN.
 * `=== '1'` would under-match a value the transitive loader can still
 * resolve to `1` — `@prisma/client` bundles `dotenv-expand`, so
 * `RUN_R2_MEDIA_SMOKE=$ONE` alongside `ONE=1` is exactly such a case.
 * Empty (`RUN_R2_MEDIA_SMOKE=`) is deliberately still allowed: that is the
 * unset placeholder `.env.example` ships and operators copy.
 *
 * The parsed object lives only inside this function and only one property
 * of it is ever looked at; nothing here returns, stores, logs or throws any
 * part of the file. The return value is a single boolean.
 */
function isOptInDeclaredInEnvFile(): boolean {
  try {
    if (!existsSync('.env')) {
      return false;
    }

    const declaredValue: string | undefined = parseEnvFileText(
      readFileSync('.env', 'utf8'),
    ).RUN_R2_MEDIA_SMOKE;

    return declaredValue !== undefined && declaredValue !== '';
  } catch {
    // Missing, unreadable, a directory, deleted mid-read, permission
    // denied: never throw at module load. `false` is not a fail-open
    // shortcut — a `.env` this process cannot read is one `dotenv` and
    // `@prisma/client` cannot read an opt-in out of either.
    return false;
  }
}

/**
 * Checked BEFORE the `.env` load below, so a poisoned `.env` can never talk
 * this file into injecting real R2 credentials into `process.env`.
 */
const declaredInEnvFile = isOptInDeclaredInEnvFile();

// Scoped, opt-in-only `.env` load. Deliberately BEFORE the gate constants
// below so a real opt-in sees the credentials it needs, and deliberately
// inside this `if` so a normal `npm test` never loads `.env` INTO
// `process.env`. Importing `dotenv` above does not: only this `config()`
// call writes to the process, and it runs on the opt-in path alone.
if (process.env.RUN_R2_MEDIA_SMOKE === '1' && !declaredInEnvFile) {
  loadEnvFileIntoProcessEnv();
}

/** Explicit human opt-in. Never set by CI, tooling, or an agent. */
const isOptedIn = process.env.RUN_R2_MEDIA_SMOKE === '1';

/**
 * NAMES only — a missing-variable report must never contain a value. Uses
 * the exact same canonical list `env.validation.ts` enforces at boot, so
 * this gate can never drift from the app's own requirements.
 */
const missingR2Keys: string[] = REQUIRED_R2_KEYS.filter(
  (key) => !process.env[key],
);

/**
 * All three conditions AND'd. The single source of truth for the gate.
 *
 * `!declaredInEnvFile` makes it fail CLOSED: even if the guard assertion
 * below were deleted, skipped or otherwise bypassed, an opt-in that came
 * out of `.env` rather than off the command line cannot resolve this gate,
 * so the round-trip suite cannot run and no network call can happen.
 */
const gateResolved =
  isOptedIn && !declaredInEnvFile && missingR2Keys.length === 0;

/**
 * The actual wiring that decides whether the round-trip suite executes.
 * Declared next to the gate it derives from, and asserted on below, so the
 * "zero network calls" promise is verified against what Jest will really
 * run rather than against `gateResolved` alone.
 */
const maybeDescribe = gateResolved ? describe : describe.skip;

/** Explicit 60 s expiry on both presigned URLs, per the approval. */
const PRESIGNED_URL_EXPIRY_SECONDS = 60;

/** Generous ceiling: ffmpeg encode + four round trips over the network. */
const NETWORK_TEST_TIMEOUT_MS = 120_000;

/**
 * NEVER skipped. This is what makes an incomplete opt-in loud: without it,
 * setting `RUN_R2_MEDIA_SMOKE=1` while (say) `OBJECT_STORAGE_BUCKET` is
 * missing would silently `describe.skip` the round trip and report a green
 * run that proved nothing.
 */
describe('R2 presigned-MP4 smoke test — opt-in integrity guard (always runs)', () => {
  it('does not silently skip when RUN_R2_MEDIA_SMOKE=1', () => {
    if (!isOptedIn) {
      // Not opted in: assert the WIRING, not `gateResolved` — the latter is
      // false by construction here, so asserting it could never fail. What
      // actually guarantees zero network calls in a normal `npm test` is
      // that the round-trip suite is bound to `describe.skip`, and that is
      // what a future refactor could silently break.
      expect(maybeDescribe).toBe(describe.skip);
      return;
    }

    // Opted in: every required variable must be present, or this FAILS and
    // names the missing ones (names only — never a value).
    expect(missingR2Keys).toEqual([]);
    expect(gateResolved).toBe(true);
  });

  it('refuses an opt-in declared in the .env file instead of on the command line', () => {
    if (declaredInEnvFile) {
      throw new Error(
        'RUN_R2_MEDIA_SMOKE is declared with a value inside the .env file. ' +
          'This slice opts in from the COMMAND LINE ONLY — e.g. ' +
          '`RUN_R2_MEDIA_SMOKE=1 npx jest src/storage/storage-r2-media-smoke.spec.ts` ' +
          '— and never from .env. Jest shares one process.env per worker ' +
          'and other specs load .env transitively (@prisma/client does so ' +
          'on import), and .env also holds the OBJECT_STORAGE_* values, so ' +
          'a flag left there turns an ordinary `npm test` into a REAL R2 ' +
          'upload/delete round trip against the private bucket. Remove the ' +
          'line from .env and pass the variable on the command line ' +
          'instead. (The round-trip suite is already blocked regardless: ' +
          'gateResolved AND-s in !declaredInEnvFile.)',
      );
    }

    expect(declaredInEnvFile).toBe(false);
  });
});

maybeDescribe(
  'R2 presigned-MP4 round trip (real network, opt-in only via RUN_R2_MEDIA_SMOKE=1 + real creds)',
  () => {
    /**
     * Unmistakably disposable: a dedicated prefix that is never a real
     * media key shape, plus epoch-ms and a UUID so repeated or concurrent
     * runs can never collide.
     */
    const objectKey = `${MEDIA_SMOKE_KEY_PREFIX}11k-${Date.now()}-${randomUUID()}.mp4`;

    let tempDir: string | undefined;
    let client: S3Client | undefined;
    let bucket: string | undefined;
    let storageService: StorageService | undefined;

    beforeAll(async () => {
      // Created here rather than inside the `it` so `afterAll` always has a
      // path to clean up, even if the `it` throws on its very first line.
      tempDir = await createTempDir();
      bucket = process.env.OBJECT_STORAGE_BUCKET;

      client = new S3Client({
        region: process.env.OBJECT_STORAGE_REGION,
        endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
        forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID!,
          secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY!,
        },
      });

      storageService = createStorageServiceFromEnv(client);
    });

    afterAll(async () => {
      // Both cleanups are unconditional and run even when the `it` threw.
      // `try/finally` (not two `.catch`es) so a temp-dir failure still
      // surfaces while never preventing the remote delete from running.
      try {
        if (tempDir !== undefined) {
          await removeTempDir(tempDir);
        }
      } finally {
        if (client !== undefined && bucket !== undefined) {
          await client
            .send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }))
            .catch(() => undefined);
        }
      }
    });

    it(
      'presigned PUT -> HEAD -> presigned GET -> SHA-256 match -> DELETE -> HEAD not-found',
      async () => {
        const dir = tempDir!;
        const service = storageService!;

        // --- 1. Synthesize and validate the fixture BEFORE any network call.
        //        If this fixture is not a real MP4, the test fails here and
        //        nothing is ever uploaded.
        const sourcePath = await generateSyntheticMp4(dir);
        const sourceProbe = await probeMp4(sourcePath);

        expect(isMp4FamilyFormat(sourceProbe.formatName)).toBe(true);
        expect(sourceProbe.hasVideo).toBe(true);
        expect(sourceProbe.hasAudio).toBe(true);
        expect(sourceProbe.durationSeconds).toBeGreaterThanOrEqual(
          SYNTHETIC_MP4_MIN_DURATION_SECONDS,
        );
        expect(sourceProbe.durationSeconds).toBeLessThanOrEqual(
          SYNTHETIC_MP4_MAX_DURATION_SECONDS,
        );
        expect(sourceProbe.sizeBytes).toBeGreaterThan(0);

        const sourceBytes = await readFile(sourcePath);
        expect(sourceBytes.byteLength).toBe(sourceProbe.sizeBytes);
        const sourceSha256 = sha256Hex(sourceBytes);

        // --- 2. Mint the presigned PUT with an explicit 60 s expiry.
        const put = await service.createPresignedPutUrl(objectKey, {
          contentType: MEDIA_SMOKE_CONTENT_TYPE,
          expiresInSeconds: PRESIGNED_URL_EXPIRY_SECONDS,
        });

        expect(put.key).toBe(objectKey);
        // Expiry is asserted on the TIMESTAMP. `put.url` is never passed to
        // `expect()`; only its length is, which leaks nothing on failure.
        expect(put.url.length).toBeGreaterThan(0);
        expect(put.expiresAt.getTime()).toBeGreaterThan(Date.now());
        expect(put.expiresAt.getTime()).toBeLessThanOrEqual(
          Date.now() + PRESIGNED_URL_EXPIRY_SECONDS * 1000,
        );
        // `expiresAt` is computed locally by `storage.service.ts`, so it
        // proves only what was REQUESTED. `X-Amz-Expires` is what the
        // signature actually commits to. Only the extracted parameter value
        // reaches `expect()` — "60" is not a secret, and the URL itself
        // still never enters an assertion (see `signedExpiresParam`).
        expect(signedExpiresParam(put.url)).toBe(
          String(PRESIGNED_URL_EXPIRY_SECONDS),
        );

        // --- 3. Upload the bytes through that presigned URL.
        const putResponse = await fetchSigned(put.url, {
          method: 'PUT',
          body: sourceBytes,
          headers: { 'Content-Type': MEDIA_SMOKE_CONTENT_TYPE },
          keyPrefixLabel: MEDIA_SMOKE_KEY_PREFIX,
        });

        expect(putResponse.status).toBeGreaterThanOrEqual(200);
        expect(putResponse.status).toBeLessThan(300);
        // Drain the (empty) success body so the socket is released. Reading a
        // 2xx body is fine; only FAILED signed responses are never read.
        await putResponse.arrayBuffer();

        // --- 4. HEAD through the real StorageService: exact size + type.
        const head = await service.headObject(objectKey);

        expect(head).not.toBeNull();
        expect(head?.key).toBe(objectKey);
        expect(head?.contentLength).toBe(sourceBytes.byteLength);
        expect(head?.contentType).toBe(MEDIA_SMOKE_CONTENT_TYPE);

        // --- 5. Mint the presigned GET with an explicit 60 s expiry.
        const get = await service.createPresignedGetUrl(objectKey, {
          expiresInSeconds: PRESIGNED_URL_EXPIRY_SECONDS,
        });

        expect(get.key).toBe(objectKey);
        expect(get.url.length).toBeGreaterThan(0);
        expect(get.expiresAt.getTime()).toBeGreaterThan(Date.now());
        expect(get.expiresAt.getTime()).toBeLessThanOrEqual(
          Date.now() + PRESIGNED_URL_EXPIRY_SECONDS * 1000,
        );
        // Same as the PUT: assert the SIGNED expiry, not just the requested
        // one. Parameter value only, never the URL.
        expect(signedExpiresParam(get.url)).toBe(
          String(PRESIGNED_URL_EXPIRY_SECONDS),
        );

        // --- 6. Download the bytes back through that presigned URL.
        const getResponse = await fetchSigned(get.url, {
          method: 'GET',
          keyPrefixLabel: MEDIA_SMOKE_KEY_PREFIX,
        });

        const downloadedBytes = Buffer.from(await getResponse.arrayBuffer());

        // --- 7. Byte-for-byte integrity.
        expect(downloadedBytes.byteLength).toBe(sourceBytes.byteLength);
        expect(sha256Hex(downloadedBytes)).toBe(sourceSha256);

        // --- 8. The downloaded copy is still a real, decodable MP4 — same
        //        container and the same streams, not just the same bytes.
        const downloadedPath = join(dir, 'downloaded.mp4');
        await writeFile(downloadedPath, downloadedBytes);
        const downloadedProbe = await probeMp4(downloadedPath);

        expect(isMp4FamilyFormat(downloadedProbe.formatName)).toBe(true);
        expect(downloadedProbe.formatName).toBe(sourceProbe.formatName);
        expect(downloadedProbe.hasVideo).toBe(sourceProbe.hasVideo);
        expect(downloadedProbe.hasAudio).toBe(sourceProbe.hasAudio);
        expect(downloadedProbe.durationSeconds).toBeCloseTo(
          sourceProbe.durationSeconds,
          3,
        );
        expect(downloadedProbe.sizeBytes).toBe(sourceProbe.sizeBytes);

        // --- 9. Delete the disposable object.
        await service.deleteObject(objectKey);

        // --- 10. Prove it is gone. `headObject` returns null for not-found.
        const finalHead = await service.headObject(objectKey);

        if (finalHead !== null) {
          throw new Error(
            '11K cleanup could not be proven: HeadObject still resolved AFTER ' +
              `DeleteObject for key "${objectKey}". A disposable smoke-test ` +
              'object may still exist in the bucket — afterAll will make one ' +
              'further best-effort delete attempt, but verify the ' +
              `"${MEDIA_SMOKE_KEY_PREFIX}" prefix is empty before running ` +
              'this again (docs/r2-readiness.md section 5).',
          );
        }

        expect(finalHead).toBeNull();
      },
      NETWORK_TEST_TIMEOUT_MS,
    );
  },
);

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Extracts ONLY the `X-Amz-Expires` query-parameter value out of a
 * presigned URL, so the SIGNED expiry can be asserted without the URL ever
 * reaching an `expect()`.
 *
 * The signed URL is a parameter here and nothing else: it is never
 * returned, re-thrown, concatenated into a message, or logged. `new URL()`
 * is wrapped because its `ERR_INVALID_URL` error carries the offending
 * input — an unparseable URL therefore yields `null`, which fails the
 * caller's assertion loudly while printing only `null` and the expected
 * `"60"`. A missing parameter yields `null` for the same reason.
 */
function signedExpiresParam(signedUrl: string): string | null {
  try {
    return new URL(signedUrl).searchParams.get('X-Amz-Expires');
  } catch {
    return null;
  }
}

/**
 * Builds a REAL `StorageService` directly, without booting Nest: the
 * production service takes a `ConfigService` and an `S3Client`, so a
 * `ConfigService`-shaped stub reading `process.env` is all it needs. This
 * deliberately exercises the SAME `createPresignedPutUrl` /
 * `createPresignedGetUrl` / `headObject` / `deleteObject` code the app
 * uses, rather than re-implementing presigning in the test.
 *
 * Only ever called from `beforeAll` inside the gated suite, so these
 * `process.env` reads never happen on a non-opted-in run.
 */
function createStorageServiceFromEnv(client: S3Client): StorageService {
  const storageConfig: StorageConfig = {
    driver: 'r2',
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT!,
    region: process.env.OBJECT_STORAGE_REGION!,
    bucket: process.env.OBJECT_STORAGE_BUCKET!,
    accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID!,
    secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY!,
    // Private bucket: no public/`r2.dev`/custom-domain delivery is used or
    // required by this slice. `buildPublicUrl` is never called here.
    publicBaseUrl: undefined,
  };

  const configService = {
    get: (key: string): StorageConfig | undefined =>
      key === 'storage' ? storageConfig : undefined,
  } as unknown as ConfigService<RootConfig>;

  return new StorageService(configService, client);
}
