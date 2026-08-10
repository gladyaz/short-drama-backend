import { RUNG_PROFILES } from './hls-profile.constants';
import { computeRenditionLadder } from './rendition-ladder';
import { HlsSourceProbe } from './hls.types';

function probe(overrides: Partial<HlsSourceProbe> = {}): HlsSourceProbe {
  return {
    width: 1080,
    height: 1920,
    rotation: 0,
    fps: 30,
    hasAudio: true,
    durationSeconds: 6,
    videoCodec: 'h264',
    audioCodec: 'aac',
    ...overrides,
  };
}

function names(rungs: { name: string }[]): string[] {
  return rungs.map((r) => r.name);
}

describe('computeRenditionLadder', () => {
  it('asserts RUNG_PROFILES[0] is the 360p tier (buildDegenerateRung depends on this ordering)', () => {
    expect(RUNG_PROFILES[0].name).toBe('360p');
  });

  // Test 1: 1080 portrait -> 4 rungs
  it('a 1080x1920 portrait source produces all 4 rungs (360/540/720/1080)', () => {
    const result = computeRenditionLadder(probe({ width: 1080, height: 1920 }));

    expect(names(result.rungs)).toEqual(['360p', '540p', '720p', '1080p']);
    expect(result.rungs[0]).toMatchObject({ width: 360, height: 640 });
    expect(result.rungs[1]).toMatchObject({ width: 540, height: 960 });
    expect(result.rungs[2]).toMatchObject({ width: 720, height: 1280 });
    expect(result.rungs[3]).toMatchObject({ width: 1080, height: 1920 });
  });

  // Test 2: 720 -> no 1080
  it('a 720x1280 source produces 360/540/720, never 1080 (no upscale)', () => {
    const result = computeRenditionLadder(probe({ width: 720, height: 1280 }));

    expect(names(result.rungs)).toEqual(['360p', '540p', '720p']);
    expect(result.rungs.some((r) => r.name === '1080p')).toBe(false);
  });

  // Test 3: 540 -> no 720/1080
  it('a 540x960 source produces 360/540 only, never 720 or 1080', () => {
    const result = computeRenditionLadder(probe({ width: 540, height: 960 }));

    expect(names(result.rungs)).toEqual(['360p', '540p']);
  });

  it('a source between 360 and 540 short side produces 360p only (boundary: 450)', () => {
    const result = computeRenditionLadder(probe({ width: 450, height: 800 }));

    expect(names(result.rungs)).toEqual(['360p']);
    expect(result.rungs[0].width).toBe(360);
  });

  it('boundary: exactly 720 short side includes the 720 tier (>= is inclusive)', () => {
    const result = computeRenditionLadder(probe({ width: 720, height: 1280 }));
    expect(names(result.rungs)).toContain('720p');
  });

  it('boundary: 719 short side excludes the 720 tier', () => {
    const result = computeRenditionLadder(probe({ width: 719, height: 1278 }));
    expect(names(result.rungs)).not.toContain('720p');
  });

  // Test 4: small source -> no upscale
  it('a sub-360p source (240x426) never upscales: one degenerate rung capped at source size', () => {
    const result = computeRenditionLadder(probe({ width: 240, height: 426 }));

    expect(result.rungs).toHaveLength(1);
    expect(result.rungs[0].width).toBeLessThanOrEqual(240);
    expect(result.rungs[0].height).toBeLessThanOrEqual(426);
    // Even-rounded (240 is already even; 426 is already even).
    expect(result.rungs[0].width).toBe(240);
    expect(result.rungs[0].height).toBe(426);
    // Reuses the lowest tier's encode settings.
    expect(result.rungs[0].profile).toBe('main');
    expect(result.rungs[0].level).toBe('3.0');
    expect(result.rungs[0].codecString).toBe('avc1.4d401e');
  });

  it('a sub-360p source with odd dimensions floors to even, never rounds up past the source', () => {
    const result = computeRenditionLadder(probe({ width: 241, height: 427 }));

    expect(result.rungs).toHaveLength(1);
    expect(result.rungs[0].width).toBe(240);
    expect(result.rungs[0].height).toBe(426);
    expect(result.rungs[0].width).toBeLessThanOrEqual(241);
    expect(result.rungs[0].height).toBeLessThanOrEqual(427);
  });

  it('never upscales any standard tier beyond the source dimensions (spot check across all tiers)', () => {
    for (const source of [
      { width: 1080, height: 1920 },
      { width: 720, height: 1280 },
      { width: 540, height: 960 },
    ]) {
      const result = computeRenditionLadder(probe(source));
      for (const rung of result.rungs) {
        expect(rung.width).toBeLessThanOrEqual(source.width);
        expect(rung.height).toBeLessThanOrEqual(source.height);
      }
    }
  });

  // Test 5: rotation metadata
  describe('rotation side-data applied before ladder math', () => {
    it('a 1920x1080-coded source rotated 90 degrees is laddered as an effective 1080x1920 portrait (4 rungs)', () => {
      const result = computeRenditionLadder(
        probe({ width: 1920, height: 1080, rotation: 90 }),
      );

      expect(result.effectiveWidth).toBe(1080);
      expect(result.effectiveHeight).toBe(1920);
      expect(names(result.rungs)).toEqual(['360p', '540p', '720p', '1080p']);
    });

    it('a 270-degree rotation also swaps effective dimensions', () => {
      const result = computeRenditionLadder(
        probe({ width: 1920, height: 1080, rotation: 270 }),
      );

      expect(result.effectiveWidth).toBe(1080);
      expect(result.effectiveHeight).toBe(1920);
    });

    it('a negative rotation (-90, counter-clockwise equivalent of 270) normalizes and swaps identically to 270', () => {
      const result = computeRenditionLadder(
        probe({ width: 1920, height: 1080, rotation: -90 }),
      );

      expect(result.effectiveWidth).toBe(1080);
      expect(result.effectiveHeight).toBe(1920);
    });

    it('a 180-degree rotation does NOT swap effective dimensions', () => {
      const result = computeRenditionLadder(
        probe({ width: 1920, height: 1080, rotation: 180 }),
      );

      expect(result.effectiveWidth).toBe(1920);
      expect(result.effectiveHeight).toBe(1080);
    });

    it('zero/absent rotation leaves dimensions untouched', () => {
      const result = computeRenditionLadder(
        probe({ width: 1080, height: 1920, rotation: 0 }),
      );

      expect(result.effectiveWidth).toBe(1080);
      expect(result.effectiveHeight).toBe(1920);
    });

    it('a rotation value outside [0,360) (e.g. 450) normalizes correctly (450 % 360 = 90)', () => {
      const result = computeRenditionLadder(
        probe({ width: 1920, height: 1080, rotation: 450 }),
      );

      expect(result.effectiveWidth).toBe(1080);
      expect(result.effectiveHeight).toBe(1920);
    });
  });

  // Test 6: no-audio stays valid
  describe('audio is a straight pass-through, independent of the ladder', () => {
    it('hasAudio=false produces includeAudio=false with a full 4-rung ladder', () => {
      const result = computeRenditionLadder(
        probe({ width: 1080, height: 1920, hasAudio: false }),
      );

      expect(result.includeAudio).toBe(false);
      expect(result.rungs).toHaveLength(4);
    });

    it('hasAudio=true produces includeAudio=true', () => {
      const result = computeRenditionLadder(probe({ hasAudio: true }));
      expect(result.includeAudio).toBe(true);
    });
  });

  // Test 7: fps capped at 30, never upconverted
  describe('fps is capped at 30 and never upconverted', () => {
    it('a 60fps source is capped to 30', () => {
      const result = computeRenditionLadder(probe({ fps: 60 }));
      expect(result.fps).toBe(30);
    });

    it('a 24fps source stays 24 (never upconverted to 30)', () => {
      const result = computeRenditionLadder(probe({ fps: 24 }));
      expect(result.fps).toBe(24);
    });

    it('exactly 30fps stays 30', () => {
      const result = computeRenditionLadder(probe({ fps: 30 }));
      expect(result.fps).toBe(30);
    });

    it('a fractional fps (29.97) is preserved, not rounded, and not upconverted', () => {
      const result = computeRenditionLadder(probe({ fps: 29.97 }));
      expect(result.fps).toBe(29.97);
    });
  });

  it('aspect ratio is preserved for a non-9:16 (4:3-ish) source, floored to even dimensions', () => {
    // 1200x1600 -> short side 1200 (portrait, 3:4 aspect).
    const result = computeRenditionLadder(probe({ width: 1200, height: 1600 }));

    const rung1080 = result.rungs.find((r) => r.name === '1080p')!;
    // width driven to 1080 (short side); height = floor(1080 * 1600/1200 / 2) * 2 = 1440.
    expect(rung1080.width).toBe(1080);
    expect(rung1080.height).toBe(1440);
    expect(rung1080.height % 2).toBe(0);
  });

  it('always produces at least one rung for any input', () => {
    const inputs: Partial<HlsSourceProbe>[] = [
      { width: 1, height: 1 },
      { width: 4000, height: 3000 },
      { width: 10, height: 5000 },
    ];

    for (const overrides of inputs) {
      const result = computeRenditionLadder(probe(overrides));
      expect(result.rungs.length).toBeGreaterThanOrEqual(1);
    }
  });
});
