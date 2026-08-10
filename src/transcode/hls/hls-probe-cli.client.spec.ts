import { execFile, execFileSync } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { HlsProbeCliClient } from './hls-probe-cli.client';

const execFileAsync = promisify(execFile);

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
 * `HlsProbeCliClient` is the ONLY file that shells out to `ffprobe` for the
 * rich probe — `SyntheticSourceService`/`HlsPackageValidator`'s own unit
 * tests inject a mock `HlsProbeClient` instead. This spec exercises the real
 * class directly against real, tiny `ffmpeg`-generated fixtures, and
 * auto-skips (11D-2b precedent) when `ffmpeg`/`ffprobe` are unavailable.
 */
const maybeDescribe = isFfmpegAvailable() ? describe : describe.skip;

maybeDescribe(
  'HlsProbeCliClient (real ffprobe, auto-skips if unavailable)',
  () => {
    let tempDir: string;

    beforeAll(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'hls-probe-it-'));
    }, 30_000);

    afterAll(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('probes dims/fps/audio/duration/codec for a plain synthetic clip (no rotation)', async () => {
      const path = join(tempDir, 'plain.mp4');
      await execFileAsync('ffmpeg', [
        '-nostdin',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=duration=1:size=320x240:rate=10',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        '-y',
        path,
      ]);

      const client = new HlsProbeCliClient();
      const probe = await client.probe(path);

      expect(probe.width).toBe(320);
      expect(probe.height).toBe(240);
      expect(probe.rotation).toBe(0);
      expect(probe.fps).toBe(10);
      expect(probe.hasAudio).toBe(true);
      expect(probe.durationSeconds).toBeCloseTo(1, 0);
      expect(probe.videoCodec).toBe('h264');
      expect(probe.audioCodec).toBe('aac');
    }, 30_000);

    it('reports hasAudio=false for a video-only source', async () => {
      const path = join(tempDir, 'no-audio.mp4');
      await execFileAsync('ffmpeg', [
        '-nostdin',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=duration=1:size=320x240:rate=10',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-y',
        path,
      ]);

      const client = new HlsProbeCliClient();
      const probe = await client.probe(path);

      expect(probe.hasAudio).toBe(false);
      expect(probe.audioCodec).toBeUndefined();
    }, 30_000);

    // Test 5 (rotation) against a REAL rotated fixture: the "3x3 displaymatrix"
    // frame side-data path (see this client's doc comment for the empirical
    // finding on this ffmpeg build) via the `h264_metadata` bitstream filter's
    // `display_orientation`/`rotate` SEI insertion.
    it('detects rotation side-data inserted via the h264_metadata bitstream filter', async () => {
      const path = join(tempDir, 'rotated.mp4');
      await execFileAsync('ffmpeg', [
        '-nostdin',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=duration=1:size=640x480:rate=10',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-bsf:v',
        'h264_metadata=display_orientation=insert:rotate=90',
        '-y',
        path,
      ]);

      const client = new HlsProbeCliClient();
      const probe = await client.probe(path);

      expect(probe.rotation).toBe(90);
    }, 30_000);
  },
);
