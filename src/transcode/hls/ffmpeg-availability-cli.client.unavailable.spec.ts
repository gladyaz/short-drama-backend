/**
 * Slice 11O — the "binary not found" branch of `FfmpegAvailabilityCliClient`,
 * isolated into its own file with `child_process` mocked at module scope
 * (never spawns a real process, so this test does NOT need to auto-skip).
 * Kept separate from `ffmpeg-availability-cli.client.spec.ts` (the REAL
 * ffmpeg/ffprobe integration test), which cannot also mock `child_process`
 * in the same file without breaking its real-process assertions.
 *
 * (A `process.env.PATH = ''` approach was tried first and rejected: on this
 * Mac, under Jest specifically, an emptied `PATH` did not reliably prevent
 * `child_process.execFile('ffmpeg', ...)` from resolving the real binary —
 * reproducible in a plain `node -e` script but not inside a Jest worker,
 * likely a libuv/posix_spawn PATH-resolution nuance specific to this
 * environment. Mocking `child_process` directly is deterministic and
 * environment-independent.)
 */
jest.mock('child_process', () => ({
  execFile: jest.fn(
    (_file: string, _args: string[], callback: (error: Error) => void) => {
      callback(new Error('spawn ENOENT'));
    },
  ),
}));

import { FfmpegAvailabilityCliClient } from './ffmpeg-availability-cli.client';

describe('FfmpegAvailabilityCliClient — binary-not-found branch (mocked child_process)', () => {
  it('reports both binaries unavailable and never throws', async () => {
    const client = new FfmpegAvailabilityCliClient();

    const result = await client.check();

    expect(result.ffmpegAvailable).toBe(false);
    expect(result.ffprobeAvailable).toBe(false);
    expect(result.ffmpegVersion).toBeUndefined();
    expect(result.ffprobeVersion).toBeUndefined();
  });
});
