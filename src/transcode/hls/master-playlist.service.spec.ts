import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MasterPlaylistService } from './master-playlist.service';
import { HlsRungArtifact, RenditionLadderResult } from './hls.types';

function rung(overrides: Partial<HlsRungArtifact['rung']> = {}) {
  return {
    name: '360p',
    width: 360,
    height: 640,
    videoBitrateKbps: 600,
    maxrateKbps: 900,
    bufsizeKbps: 1800,
    profile: 'main' as const,
    level: '3.0',
    codecString: 'avc1.4d401e',
    ...overrides,
  };
}

function artifact(overrides: Partial<HlsRungArtifact> = {}): HlsRungArtifact {
  return {
    rung: rung(),
    outputDir: '/tmp/whatever/360p',
    playlistRelativePath: '360p/index.m3u8',
    totalMediaBytes: 100_000,
    segmentCount: 2,
    ...overrides,
  };
}

function ladder(
  overrides: Partial<RenditionLadderResult> = {},
): RenditionLadderResult {
  return {
    rungs: [rung()],
    fps: 30,
    includeAudio: true,
    effectiveWidth: 1080,
    effectiveHeight: 1920,
    ...overrides,
  };
}

describe('MasterPlaylistService', () => {
  let service: MasterPlaylistService;

  beforeEach(() => {
    service = new MasterPlaylistService();
  });

  it('produces a playlist starting with #EXTM3U', () => {
    const { text } = service.build('/pkg', ladder(), [artifact()], 6);
    expect(text.startsWith('#EXTM3U\n')).toBe(true);
  });

  it('includes exactly one #EXT-X-STREAM-INF + URI pair per produced artifact', () => {
    const artifacts = [
      artifact({
        rung: rung({ name: '360p' }),
        playlistRelativePath: '360p/index.m3u8',
      }),
      artifact({
        rung: rung({ name: '540p', width: 540, height: 960 }),
        playlistRelativePath: '540p/index.m3u8',
      }),
    ];

    const { text } = service.build('/pkg', ladder(), artifacts, 6);
    const streamInfCount = (text.match(/#EXT-X-STREAM-INF/g) ?? []).length;

    expect(streamInfCount).toBe(2);
    expect(text).toContain('360p/index.m3u8');
    expect(text).toContain('540p/index.m3u8');
  });

  it('computes peak BANDWIDTH as (maxrate + audio bitrate) * 1.05, rounded up', () => {
    const { text } = service.build(
      '/pkg',
      ladder({ includeAudio: true }),
      [artifact()],
      6,
    );
    // (900_000 + 96_000) * 1.05 = 1,045,800
    expect(text).toContain('BANDWIDTH=1045800');
  });

  it('omits the audio bitrate from peak BANDWIDTH when includeAudio is false', () => {
    const { text } = service.build(
      '/pkg',
      ladder({ includeAudio: false }),
      [artifact()],
      6,
    );
    // 900_000 * 1.05 = 945,000
    expect(text).toContain('BANDWIDTH=945000');
  });

  it('computes AVERAGE-BANDWIDTH from real measured bytes / duration', () => {
    const { text } = service.build(
      '/pkg',
      ladder(),
      [artifact({ totalMediaBytes: 750_000 })],
      6,
    );
    // 750_000 * 8 / 6 = 1,000,000
    expect(text).toContain('AVERAGE-BANDWIDTH=1000000');
  });

  it('CODECS includes mp4a.40.2 when includeAudio is true', () => {
    const { text } = service.build(
      '/pkg',
      ladder({ includeAudio: true }),
      [artifact()],
      6,
    );
    expect(text).toContain('CODECS="avc1.4d401e,mp4a.40.2"');
  });

  // Test 6: no-audio master omits the audio codec entirely.
  it('CODECS omits mp4a.40.2 entirely when includeAudio is false', () => {
    const { text } = service.build(
      '/pkg',
      ladder({ includeAudio: false }),
      [artifact()],
      6,
    );
    expect(text).toContain('CODECS="avc1.4d401e"');
    expect(text).not.toContain('mp4a');
  });

  it('includes RESOLUTION matching the rung dimensions', () => {
    const { text } = service.build(
      '/pkg',
      ladder(),
      [artifact({ rung: rung({ width: 720, height: 1280 }) })],
      6,
    );
    expect(text).toContain('RESOLUTION=720x1280');
  });

  it('includes FRAME-RATE matching the ladder fps', () => {
    const { text } = service.build(
      '/pkg',
      ladder({ fps: 24 }),
      [artifact()],
      6,
    );
    expect(text).toContain('FRAME-RATE=24');
  });

  it('writes the built text to the expected master.m3u8 path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'master-playlist-spec-'));
    try {
      const build = service.build('/unused', ladder(), [artifact()], 6);
      const realBuild = { ...build, path: join(dir, 'master.m3u8') };

      await service.write(realBuild);

      const written = await readFile(realBuild.path, 'utf8');
      expect(written).toBe(realBuild.text);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Test 9: master includes exactly the produced variants (order/exact set).
  it('advertises exactly the produced rungs — no more, no fewer', () => {
    const artifacts = [
      artifact({
        rung: rung({ name: '360p' }),
        playlistRelativePath: '360p/index.m3u8',
      }),
      artifact({
        rung: rung({ name: '1080p', width: 1080, height: 1920 }),
        playlistRelativePath: '1080p/index.m3u8',
      }),
    ];

    const { text } = service.build('/pkg', ladder(), artifacts, 6);
    const uris = text
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith('#'));

    expect(uris.sort()).toEqual(['1080p/index.m3u8', '360p/index.m3u8']);
  });
});
