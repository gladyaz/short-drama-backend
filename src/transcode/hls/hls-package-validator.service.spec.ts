import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { HlsPackageValidator } from './hls-package-validator.service';
import {
  HlsProbeClient,
  HlsRungArtifact,
  HlsSourceProbe,
  RenditionLadderResult,
} from './hls.types';

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

function fakeProbe(overrides: Partial<HlsSourceProbe> = {}): HlsSourceProbe {
  return {
    width: 360,
    height: 640,
    rotation: 0,
    fps: 30,
    hasAudio: true,
    durationSeconds: 6,
    videoCodec: 'h264',
    audioCodec: 'aac',
    ...overrides,
  };
}

/** Builds a real, valid-shaped package on disk: master.m3u8 + one rung's index.m3u8/init.mp4/segments. */
async function buildValidPackage(
  root: string,
): Promise<{ artifact: HlsRungArtifact; masterText: string }> {
  const rungDir = join(root, '360p');
  await mkdir(rungDir, { recursive: true });
  await writeFile(join(rungDir, 'init.mp4'), Buffer.alloc(100));
  await writeFile(join(rungDir, 'seg_00000.m4s'), Buffer.alloc(500));
  await writeFile(join(rungDir, 'seg_00001.m4s'), Buffer.alloc(300));
  await writeFile(
    join(rungDir, 'index.m3u8'),
    [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:4.000000,',
      'seg_00000.m4s',
      '#EXTINF:2.000000,',
      'seg_00001.m4s',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n'),
  );

  const artifact: HlsRungArtifact = {
    rung: rung(),
    outputDir: rungDir,
    playlistRelativePath: '360p/index.m3u8',
    totalMediaBytes: 900,
    segmentCount: 2,
  };

  const masterText = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=360x640,CODECS="avc1.4d401e,mp4a.40.2"',
    '360p/index.m3u8',
    '',
  ].join('\n');

  await writeFile(join(root, 'master.m3u8'), masterText);

  return { artifact, masterText };
}

describe('HlsPackageValidator', () => {
  let tempDir: string;
  // Held as a standalone binding (never accessed as `probeClient.probe`) so
  // assertions never trigger `@typescript-eslint/unbound-method` — a jest
  // mock function has no meaningful `this` binding to lose, but the rule
  // cannot tell that from a bare object-method reference.
  let probeMock: jest.Mock;
  let probeClient: jest.Mocked<HlsProbeClient>;
  let validator: HlsPackageValidator;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hls-validator-spec-'));
    probeMock = jest.fn().mockResolvedValue(fakeProbe());
    probeClient = { probe: probeMock };
    validator = new HlsPackageValidator(probeClient);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('a fully valid package passes with zero issues', async () => {
    const { artifact, masterText } = await buildValidPackage(tempDir);

    const result = await validator.validate(
      tempDir,
      ladder(),
      [artifact],
      6,
      masterText,
    );

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(probeMock).toHaveBeenCalledWith(
      join(tempDir, artifact.playlistRelativePath),
    );
  });

  it('fails when master.m3u8 does not start with #EXTM3U', async () => {
    const { artifact } = await buildValidPackage(tempDir);

    const result = await validator.validate(
      tempDir,
      ladder(),
      [artifact],
      6,
      'not a real playlist',
    );

    expect(result.valid).toBe(false);
    expect(result.issues[0].code).toBe('MASTER_PLAYLIST_UNPARSEABLE');
  });

  // Test 9 (negative direction): master references a rung that wasn't produced, or omits one that was.
  it('fails when the master references a different set of rungs than were produced', async () => {
    const { artifact } = await buildValidPackage(tempDir);
    const wrongMasterText = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1x1,CODECS="avc1.4d401e"',
      '540p/index.m3u8', // does not match the produced 360p artifact
      '',
    ].join('\n');

    const result = await validator.validate(
      tempDir,
      ladder(),
      [artifact],
      6,
      wrongMasterText,
    );

    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain(
      'MASTER_PLAYLIST_RUNG_MISMATCH',
    );
  });

  // Test 10: missing segment -> validation fails.
  it('fails when a segment referenced by the variant playlist does not exist on disk', async () => {
    const { artifact, masterText } = await buildValidPackage(tempDir);
    await rm(join(tempDir, '360p', 'seg_00001.m4s'));

    const result = await validator.validate(
      tempDir,
      ladder(),
      [artifact],
      6,
      masterText,
    );

    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'ARTIFACT_MISSING')).toBe(true);
  });

  it('fails when the init segment referenced by #EXT-X-MAP does not exist', async () => {
    const { artifact, masterText } = await buildValidPackage(tempDir);
    await rm(join(tempDir, '360p', 'init.mp4'));

    const result = await validator.validate(
      tempDir,
      ladder(),
      [artifact],
      6,
      masterText,
    );

    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'ARTIFACT_MISSING')).toBe(true);
  });

  it('fails when the variant playlist itself does not exist', async () => {
    const { artifact, masterText } = await buildValidPackage(tempDir);
    const missingArtifact: HlsRungArtifact = {
      ...artifact,
      playlistRelativePath: '360p/nonexistent.m3u8',
    };

    const result = await validator.validate(
      tempDir,
      ladder(),
      [missingArtifact],
      6,
      masterText.replace('360p/index.m3u8', '360p/nonexistent.m3u8'),
    );

    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'ARTIFACT_MISSING')).toBe(true);
  });

  // Test 11: zero-byte artifact -> validation fails.
  it('fails when a segment file exists but is zero bytes', async () => {
    const { artifact, masterText } = await buildValidPackage(tempDir);
    await writeFile(join(tempDir, '360p', 'seg_00001.m4s'), Buffer.alloc(0));

    const result = await validator.validate(
      tempDir,
      ladder(),
      [artifact],
      6,
      masterText,
    );

    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'ARTIFACT_ZERO_BYTES')).toBe(
      true,
    );
  });

  it('fails when the variant playlist itself is zero bytes', async () => {
    const { artifact, masterText } = await buildValidPackage(tempDir);
    await writeFile(join(tempDir, '360p', 'index.m3u8'), '');

    const result = await validator.validate(
      tempDir,
      ladder(),
      [artifact],
      6,
      masterText,
    );

    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'ARTIFACT_ZERO_BYTES')).toBe(
      true,
    );
  });

  // Test 8: traversal attempt is rejected.
  it('rejects a variant playlist reference that resolves outside the package root (path traversal)', async () => {
    const { artifact, masterText } = await buildValidPackage(tempDir);
    const traversalArtifact: HlsRungArtifact = {
      ...artifact,
      playlistRelativePath: '../../etc/passwd',
    };

    const result = await validator.validate(
      tempDir,
      ladder(),
      [traversalArtifact],
      6,
      masterText.replace('360p/index.m3u8', '../../etc/passwd'),
    );

    expect(result.valid).toBe(false);
    expect(
      result.issues.some((i) => i.code === 'PATH_OUTSIDE_PACKAGE_ROOT'),
    ).toBe(true);
  });

  it('rejects a segment reference embedded inside the variant playlist that attempts traversal', async () => {
    const rungDir = join(tempDir, '360p');
    await mkdir(rungDir, { recursive: true });
    await writeFile(join(rungDir, 'init.mp4'), Buffer.alloc(10));
    await writeFile(
      join(rungDir, 'index.m3u8'),
      [
        '#EXTM3U',
        '#EXT-X-MAP:URI="init.mp4"',
        '#EXTINF:4.0,',
        '../../../../etc/passwd',
        '#EXT-X-ENDLIST',
        '',
      ].join('\n'),
    );

    const artifact: HlsRungArtifact = {
      rung: rung(),
      outputDir: rungDir,
      playlistRelativePath: '360p/index.m3u8',
      totalMediaBytes: 10,
      segmentCount: 1,
    };
    const masterText = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=360x640,CODECS="avc1.4d401e"',
      '360p/index.m3u8',
      '',
    ].join('\n');

    const result = await validator.validate(
      tempDir,
      ladder(),
      [artifact],
      6,
      masterText,
    );

    expect(result.valid).toBe(false);
    expect(
      result.issues.some((i) => i.code === 'PATH_OUTSIDE_PACKAGE_ROOT'),
    ).toBe(true);
  });

  it('fails when the probed dimensions do not match the claimed rung dimensions', async () => {
    const { artifact, masterText } = await buildValidPackage(tempDir);
    probeMock.mockResolvedValue(fakeProbe({ width: 361, height: 640 }));

    const result = await validator.validate(
      tempDir,
      ladder(),
      [artifact],
      6,
      masterText,
    );

    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'DIMENSION_MISMATCH')).toBe(
      true,
    );
  });

  it('fails when the probed duration is far outside tolerance of the source duration', async () => {
    const { artifact, masterText } = await buildValidPackage(tempDir);
    probeMock.mockResolvedValue(fakeProbe({ durationSeconds: 60 }));

    const result = await validator.validate(
      tempDir,
      ladder(),
      [artifact],
      6,
      masterText,
    );

    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'DURATION_MISMATCH')).toBe(
      true,
    );
  });

  it('fails when the segment count is far from duration/4s', async () => {
    const rungDir = join(tempDir, '360p');
    await mkdir(rungDir, { recursive: true });
    await writeFile(join(rungDir, 'init.mp4'), Buffer.alloc(10));
    // 6s of content should be ~2 segments; write only 1 referenced segment total but claim a huge duration mismatch scenario instead:
    await writeFile(join(rungDir, 'seg_00000.m4s'), Buffer.alloc(10));
    await writeFile(
      join(rungDir, 'index.m3u8'),
      [
        '#EXTM3U',
        '#EXT-X-MAP:URI="init.mp4"',
        '#EXTINF:4.0,',
        'seg_00000.m4s',
        '#EXT-X-ENDLIST',
        '',
      ].join('\n'),
    );

    const artifact: HlsRungArtifact = {
      rung: rung(),
      outputDir: rungDir,
      playlistRelativePath: '360p/index.m3u8',
      totalMediaBytes: 10,
      segmentCount: 1,
    };
    const masterText = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=360x640,CODECS="avc1.4d401e"',
      '360p/index.m3u8',
      '',
    ].join('\n');

    // Source claims 40 seconds -> expected ~10 segments, only 1 present.
    const result = await validator.validate(
      tempDir,
      ladder(),
      [artifact],
      40,
      masterText,
    );

    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'SEGMENT_COUNT_INSANE')).toBe(
      true,
    );
  });

  it('fails when a produced rung has more pixels than the source (upscale detected)', async () => {
    const { masterText } = await buildValidPackage(tempDir);
    const upscaledArtifact: HlsRungArtifact = {
      rung: rung({ width: 4000, height: 4000 }),
      outputDir: join(tempDir, '360p'),
      playlistRelativePath: '360p/index.m3u8',
      totalMediaBytes: 900,
      segmentCount: 2,
    };
    probeMock.mockResolvedValue(fakeProbe({ width: 4000, height: 4000 }));

    const result = await validator.validate(
      tempDir,
      ladder({ effectiveWidth: 1080, effectiveHeight: 1920 }),
      [upscaledArtifact],
      6,
      masterText.replace('RESOLUTION=360x640', 'RESOLUTION=4000x4000'),
    );

    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'UPSCALE_DETECTED')).toBe(true);
  });

  it('fails when ffprobe cannot inspect the produced variant', async () => {
    const { artifact, masterText } = await buildValidPackage(tempDir);
    probeMock.mockRejectedValue(new Error('moov atom not found'));

    const result = await validator.validate(
      tempDir,
      ladder(),
      [artifact],
      6,
      masterText,
    );

    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'VARIANT_NOT_PROBEABLE')).toBe(
      true,
    );
  });
});
