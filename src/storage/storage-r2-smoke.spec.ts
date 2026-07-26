import { randomUUID } from 'crypto';
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { REQUIRED_R2_KEYS } from '../config/env.validation';

/**
 * Phase 11, work unit 11G-4. OPTIONAL real-R2 disposable-object round-trip
 * smoke test, mirroring the auto-skip pattern used by the real-ffmpeg
 * integration test in `thumbnails/thumbnail.service.spec.ts`
 * (`maybeDescribe`/`describe.skip`). This suite makes a REAL network call
 * against a REAL, already-existing R2 (or other S3-compatible) bucket, so
 * it is gated behind BOTH:
 *   1. `RUN_R2_SMOKE=1` — an explicit, human-set opt-in (never set in CI or
 *      by default), and
 *   2. every `OBJECT_STORAGE_*` variable name in `REQUIRED_R2_KEYS` (the
 *      exact same list `env.validation.ts` requires at boot for
 *      `STORAGE_DRIVER=r2`) actually being present in the environment.
 *
 * When either condition is false — which is always true in this
 * credential-free session, and true by default everywhere else (`npm test`,
 * CI) — the whole suite is skipped via `describe.skip` and ZERO network
 * calls are made: `hasOptedIntoR2Smoke()` only reads `process.env`, never
 * constructs an `S3Client` or calls `.send()`.
 *
 * This test NEVER creates a bucket. It only `PutObject`s a single,
 * uniquely-named, clearly-disposable key into an EXISTING bucket, confirms
 * it landed with `HeadObject`, then `DeleteObject`s it in `afterAll` — the
 * `afterAll` cleanup runs even if the `it` body throws, and also
 * double-checks (via a final `HeadObject` expected to 404) that no residue
 * is left behind. See `docs/r2-readiness.md` for the full cleanup plan.
 */
function hasOptedIntoR2Smoke(): boolean {
  if (process.env.RUN_R2_SMOKE !== '1') {
    return false;
  }

  return REQUIRED_R2_KEYS.every((key) => Boolean(process.env[key]));
}

const maybeDescribe = hasOptedIntoR2Smoke() ? describe : describe.skip;

maybeDescribe(
  'R2 disposable-object smoke test (real network, opt-in only via RUN_R2_SMOKE=1 + real creds)',
  () => {
    // Prefixed and uniquely suffixed so it is unmistakably disposable and
    // never collides with a real media object key.
    const disposableKey = `_r2-smoke-tests/11g-4-${Date.now()}-${randomUUID()}.txt`;
    let client: S3Client;
    let bucket: string;

    beforeAll(() => {
      bucket = process.env.OBJECT_STORAGE_BUCKET!;
      client = new S3Client({
        region: process.env.OBJECT_STORAGE_REGION!,
        endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
        forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID!,
          secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY!,
        },
      });
    });

    afterAll(async () => {
      // Best-effort cleanup: always attempt the delete, even if the `it`
      // body above failed partway through the round-trip, so a failed
      // assertion never leaves the disposable object behind.
      await client
        .send(new DeleteObjectCommand({ Bucket: bucket, Key: disposableKey }))
        .catch(() => undefined);
    });

    it('round-trips a disposable object: put -> head -> delete -> confirm removed', async () => {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: disposableKey,
          Body: Buffer.from('11g-4 disposable r2 smoke-test object'),
          ContentType: 'text/plain',
        }),
      );

      const head = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: disposableKey }),
      );
      expect(head.ContentLength).toBeGreaterThan(0);

      await client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: disposableKey }),
      );

      await expect(
        client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: disposableKey }),
        ),
      ).rejects.toThrow();
    }, 30000);
  },
);
