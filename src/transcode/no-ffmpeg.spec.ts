import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Strips both block (`/* ... *\/`, including JSDoc) and line (`// ...`)
 * comments before the pattern checks below run — this file's OWN doc
 * comments legitimately explain, in prose, that this module never touches
 * ffmpeg/child_process (see e.g. `bullmq-transcode-queue.client.ts`'s class
 * doc), which would otherwise false-positive against a naive whole-file text
 * scan. A regex-based strip is sufficient here (this is a static self-check
 * on this repo's own source, not a security boundary) — none of these files
 * embed either comment delimiter inside a string literal.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * Slice 11N, proof 12: "No FFmpeg anywhere in the new module." A static
 * source-text assertion, not a behavioral one — reads every `.ts` file
 * directly under `src/transcode/` (excluding this spec file itself and
 * other `.spec.ts` files, which legitimately reference module NAMES like
 * `'bullmq'`/`'ioredis'` in mock setup but never ffmpeg) and, after
 * stripping comments, asserts none of them import/require
 * `child_process`, call `execFile`/`execFileSync`/`execSync`/`spawn`/
 * `spawnSync`, or mention `ffmpeg`/`ffprobe` in actual code. This slice is a
 * data-model + queue foundation; probing/transcoding a real video file is
 * explicitly out of scope until the worker slice (11O+) that does not exist
 * yet (2026-08-10 DECISIONS.md approval, hard prohibition: "no FFmpeg").
 */
describe('src/transcode/** — no FFmpeg anywhere (proof 12)', () => {
  const transcodeDir = __dirname;

  const sourceFiles = readdirSync(transcodeDir).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'),
  );

  it('found at least one non-test source file to scan (the assertions below are non-vacuous)', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it.each(sourceFiles)(
    '%s (comments stripped) does not import child_process, call exec*/spawn*, or mention ffmpeg/ffprobe',
    (fileName) => {
      const code = stripComments(
        readFileSync(join(transcodeDir, fileName), 'utf8'),
      ).toLowerCase();

      expect(code).not.toMatch(/child_process/);
      expect(code).not.toMatch(
        /\b(exec|execfile|execsync|execfilesync|spawn|spawnsync)\s*\(/,
      );
      expect(code).not.toMatch(/ffmpeg/);
      expect(code).not.toMatch(/ffprobe/);
    },
  );
});
