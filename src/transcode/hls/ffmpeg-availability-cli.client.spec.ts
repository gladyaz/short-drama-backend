import { execFileSync } from 'child_process';
import { FfmpegAvailabilityCliClient } from './ffmpeg-availability-cli.client';

function isFfmpegAvailable(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * The real, CLI-shelling client — no other test in this slice constructs it
 * directly (`WorkerReadinessService`'s unit tests inject a mock
 * `FfmpegAvailabilityClient` interface instead). Every test here auto-skips
 * (11D-2b precedent) when `ffmpeg`/`ffprobe` are not on `PATH`.
 */
const maybeDescribe = isFfmpegAvailable() ? describe : describe.skip;

maybeDescribe(
  'FfmpegAvailabilityCliClient (real ffmpeg/ffprobe, auto-skips if unavailable)',
  () => {
    it('reports both binaries available with a non-empty version string', async () => {
      const client = new FfmpegAvailabilityCliClient();

      const result = await client.check();

      expect(result.ffmpegAvailable).toBe(true);
      expect(result.ffprobeAvailable).toBe(true);
      expect(result.ffmpegVersion).toMatch(/^\d/);
      expect(result.ffprobeVersion).toMatch(/^\d/);
    });
  },
);

// The "binary not found" branch is covered deterministically, with
// `child_process` mocked, in `ffmpeg-availability-cli.client.unavailable.spec.ts`
// — see that file's doc comment for why a `PATH`-manipulation approach was
// tried first and rejected as unreliable under Jest on this platform.
