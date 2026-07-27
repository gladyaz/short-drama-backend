import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { VIDEOS } from '../src/videos/videos.data';
import { resolveSafeStoragePath } from '../src/videos/storage-path.util';

/**
 * CI-1 (Early CI Quality-Gate Baseline — DECISIONS.md, 2026-07-27): generates
 * minimal placeholder media files under STORAGE_ROOT so the byte-range
 * stream e2e tests (`test/videos.e2e-spec.ts`) can exercise
 * `GET /videos/:id/stream` -> 206 Partial Content without the real company
 * MP4s, which are intentionally never committed to this repo (see
 * `.gitignore`'s `*.mp4` rule) and are not present on a CI runner.
 *
 * Investigation (CI-1): only two seed `storageKey`s are ever requested with
 * a `Range` header that asserts a 206 in `test/videos.e2e-spec.ts` —
 * `video-104-01` ("Series 104/1_subtitled.mp4", the free episode) and
 * `video-104-06` ("Series 104/6_subtitled.mp4", the premium episode) — both
 * via `Range: bytes=0-1023`, so a placeholder needs only to be >= 1024
 * bytes (`parseRangeHeader` in `src/videos/video-range.util.ts` rejects any
 * range with `end >= fileSize`). No test asserts specific byte content,
 * length beyond the requested range, or a real MP4 container — the
 * controller (`VideosController#streamVideo`) hardcodes
 * `Content-Type: video/mp4` regardless of what is actually on disk. Every
 * other e2e fixture that exercises `/videos/:id/stream` deliberately uses
 * an empty `storageKey` and asserts `MEDIA_FILE_NOT_FOUND` (404), which
 * requires no file on disk at all.
 *
 * This script nonetheless generates a placeholder for every one of the 40
 * seed rows in `VIDEOS` (the same source of truth `prisma/seed.ts` already
 * uses, avoiding a second hand-maintained list that could drift), not just
 * the two above, so it stays correct without being re-derived by hand if a
 * future e2e spec exercises a different episode's byte range. This is
 * cheap: 40 tiny zero-filled files.
 *
 * CRITICAL safety property (AGENT_RULES.md: "Never modify or delete company
 * video files [...] under the backend's STORAGE_ROOT"): this script NEVER
 * overwrites a file that already exists at the target path — it only ever
 * creates a file that is currently absent. If STORAGE_ROOT were ever
 * accidentally pointed at a real, populated company storage folder instead
 * of a fresh/throwaway CI directory, every one of these 40 target paths
 * would already exist as a real file, and this script would skip all of
 * them without writing a single byte.
 */

const PLACEHOLDER_SIZE_BYTES = 8192; // Comfortably above the 1024-byte Range the e2e suite requests.

function main(): void {
  const storageRoot = process.env.STORAGE_ROOT;
  if (!storageRoot) {
    throw new Error(
      'STORAGE_ROOT is not set. Refusing to generate placeholder media ' +
        'fixtures without an explicit target directory.',
    );
  }

  mkdirSync(storageRoot, { recursive: true });

  const placeholder = Buffer.alloc(PLACEHOLDER_SIZE_BYTES); // zero-filled, not a real MP4.

  let created = 0;
  let skipped = 0;

  for (const video of VIDEOS) {
    const absolutePath = resolveSafeStoragePath(storageRoot, video.storageKey);

    // Never overwrite a file that already exists — see the safety property
    // documented above.
    if (existsSync(absolutePath)) {
      skipped += 1;
      continue;
    }

    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, placeholder);
    created += 1;
  }

  // eslint-disable-next-line no-console
  console.log(
    `Media fixtures: created ${created}, skipped ${skipped} (already present) ` +
      `under ${storageRoot}.`,
  );
}

main();
