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
 * `spawnSync`, or mention `ffmpeg`/`ffprobe` in actual code. 11N itself was a
 * data-model + queue foundation only; probing/transcoding a real video file
 * was explicitly out of scope for it until the worker slice (11O+)
 * (2026-08-10 DECISIONS.md approval, hard prohibition: "no FFmpeg").
 *
 * **Slice 11P amendment.** `TranscodeJobProcessor`/`TranscodeJanitorService`
 * are the real production worker/janitor logic — they legitimately
 * ORCHESTRATE the transcode pipeline (e.g. an `errorCode` string literal
 * `"PROBE_FAILED"`, or a log line naming which step failed) without ever
 * DIRECTLY shelling out to a binary themselves; every actual `child_process`
 * call still lives exclusively in `src/transcode/hls/*-cli.client.ts` (Slice
 * 11O), reached only through the injected `HlsProbeClient`/`HlsEncoderClient`/
 * `ThumbnailClient`/`FfmpegAvailabilityClient` abstractions. The
 * `child_process`/`exec*`/`spawn*` assertion below still applies to EVERY
 * file in this directory, including these two — that invariant ("no direct
 * process spawning outside the injected `hls/` CLI clients") is exactly as
 * load-bearing for 11P as it was for 11N. Only the narrower literal
 * `ffmpeg`/`ffprobe` substring check is skipped for this small, explicit,
 * documented allowlist of 11P files whose whole job is to talk ABOUT those
 * tools (never TO them directly) — every other file in this directory is
 * still held to the full, original check.
 */
describe('src/transcode/** — no FFmpeg anywhere (proof 12)', () => {
  const transcodeDir = __dirname;

  const sourceFiles = readdirSync(transcodeDir).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'),
  );

  /**
   * Slice 11P: files permitted to MENTION ffmpeg/ffprobe in actual code
   * (e.g. a bounded error-code string, a log message) — never to import
   * `child_process` or call `exec*`/`spawn*` (still checked below,
   * unconditionally, for every file including these two).
   */
  const ALLOWED_TO_MENTION_FFMPEG_BY_NAME = new Set([
    'transcode-job-processor.service.ts',
    'transcode-janitor.service.ts',
  ]);

  it('found at least one non-test source file to scan (the assertions below are non-vacuous)', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it.each(sourceFiles)(
    '%s (comments stripped) does not import child_process or call exec*/spawn*',
    (fileName) => {
      const code = stripComments(
        readFileSync(join(transcodeDir, fileName), 'utf8'),
      ).toLowerCase();

      expect(code).not.toMatch(/child_process/);
      expect(code).not.toMatch(
        /\b(exec|execfile|execsync|execfilesync|spawn|spawnsync)\s*\(/,
      );
    },
  );

  it.each(
    sourceFiles.filter((name) => !ALLOWED_TO_MENTION_FFMPEG_BY_NAME.has(name)),
  )(
    '%s (comments stripped) does not mention ffmpeg/ffprobe in actual code',
    (fileName) => {
      const code = stripComments(
        readFileSync(join(transcodeDir, fileName), 'utf8'),
      ).toLowerCase();

      expect(code).not.toMatch(/ffmpeg/);
      expect(code).not.toMatch(/ffprobe/);
    },
  );
});
