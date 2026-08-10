import { MAX_OUTPUT_FPS, RUNG_PROFILES } from './hls-profile.constants';
import {
  HlsSourceProbe,
  RenditionLadderResult,
  RenditionLadderRung,
  RungProfile,
} from './hls.types';

/**
 * Slice 11O — pure, unit-testable rendition ladder function (proposal §3,
 * 2026-08-10 approval binding constraint 4). Deliberately takes only a plain
 * data object and returns only a plain data object — no I/O, no ffmpeg, no
 * Nest DI — so every rule below is exercised directly, with zero mocking.
 *
 * ## Rules (implemented exactly as approved)
 *
 * 1. **Rotation applied BEFORE ladder math.** A source whose display
 *    orientation is rotated 90°/270° (either direction) has its width and
 *    height swapped before anything else is computed — a portrait video
 *    stored as rotated landscape is laddered on its DISPLAY dimensions, not
 *    its coded ones. 180° does not swap (the frame is upside-down, not
 *    sideways). Any other rotation value is normalized into `[0, 360)`
 *    first, so `-90`/`-270`/`450` etc. all resolve correctly.
 * 2. **Tier selection by SHORT side, filtered against the frozen table.**
 *    `RUNG_PROFILES` is ascending by nominal short side (360/540/720/1080).
 *    Every tier whose nominal short side is `<=` the source's effective
 *    short side is included — this is exactly equivalent to the approval's
 *    condensed "≥1080→4, ≥720→3, ≥540→2, else→360p only" description (a
 *    source at e.g. short side 750 qualifies for 360/540/720 but not 1080;
 *    a source at short side 450 qualifies for 360 only), while also
 *    correctly handling every boundary value (exactly 360/540/720/1080).
 * 3. **Never upscale.** A tier is only ever included when its nominal short
 *    side does not exceed the source's own effective short side, so no
 *    standard tier can ever enlarge the source. A source below the smallest
 *    tier (effective short side `< 360`) matches ZERO standard tiers; per
 *    the architecture's explicit "a sub-360p source gets one normalized
 *    rung capped at source size" rule, this produces exactly ONE degenerate
 *    rung sized to the source's own (even-rounded, never rounded UP)
 *    dimensions, using the lowest tier's bitrate/profile/level/codec
 *    values (the lowest-quality profile in the table is the correct fit for
 *    a rung that is, by construction, smaller than the smallest defined
 *    tier). This is the "no upscale beyond even-rounding" rule from the
 *    approval, and `evenFloor` (never `evenRound`/`evenCeil`) is what makes
 *    it strict: the computed dimension can never exceed the source's own.
 * 4. **Aspect preserved exactly**, computed generically (not hardcoded to
 *    9:16) so an unusual source aspect ratio still ladders correctly: the
 *    tier's nominal short side becomes the driving dimension, and the other
 *    dimension is derived proportionally and floored to the nearest even
 *    number (mirrors ffmpeg's own `scale=-2:h`/`scale=w:-2` behavior). For
 *    an exactly-9:16 source this reproduces the frozen table's nominal
 *    dimensions exactly (e.g. 1080×1920 → 360×640, 540×960, 720×1280,
 *    1080×1920 — see `rendition-ladder.spec.ts`).
 * 5. **fps preserved, capped at `MAX_OUTPUT_FPS` (30), never upconverted.**
 *    `Math.min(source fps, 30)` — a 24fps source stays 24fps; a 60fps source
 *    is capped to 30fps.
 * 6. **Audio ladder-independent.** `includeAudio` is a straight pass-through
 *    of `probe.hasAudio` — a source with no audio produces a ladder (and,
 *    downstream, a master playlist) with zero audio codec references,
 *    exactly matching "no-audio stays valid" (test 6).
 * 7. **Always ≥1 rung.** Every branch (standard tiers or the degenerate
 *    single rung) produces at least one entry; there is no input for which
 *    this function returns an empty ladder.
 */
export function computeRenditionLadder(
  probe: HlsSourceProbe,
): RenditionLadderResult {
  const normalizedRotation = ((probe.rotation % 360) + 360) % 360;
  const isSideways = normalizedRotation === 90 || normalizedRotation === 270;

  const effectiveWidth = isSideways ? probe.height : probe.width;
  const effectiveHeight = isSideways ? probe.width : probe.height;
  const effectiveShortSide = Math.min(effectiveWidth, effectiveHeight);
  const isPortraitOrSquare = effectiveWidth <= effectiveHeight;

  const qualifyingTiers = RUNG_PROFILES.filter(
    (tier) => tier.shortSide <= effectiveShortSide,
  );

  const rungs: RenditionLadderRung[] =
    qualifyingTiers.length > 0
      ? qualifyingTiers.map((tier) =>
          buildStandardRung(
            tier,
            effectiveWidth,
            effectiveHeight,
            isPortraitOrSquare,
          ),
        )
      : [buildDegenerateRung(effectiveWidth, effectiveHeight)];

  return {
    rungs,
    fps: Math.min(probe.fps, MAX_OUTPUT_FPS),
    includeAudio: probe.hasAudio,
    effectiveWidth,
    effectiveHeight,
  };
}

/** Floors `n` to the nearest even integer — never rounds up, so this can never exceed the true proportional value (the "no upscale" guarantee). */
function evenFloor(n: number): number {
  return Math.floor(n / 2) * 2;
}

function buildStandardRung(
  tier: RungProfile,
  effectiveWidth: number,
  effectiveHeight: number,
  isPortraitOrSquare: boolean,
): RenditionLadderRung {
  const shortSide = tier.shortSide;
  const width = isPortraitOrSquare
    ? shortSide
    : evenFloor((shortSide * effectiveWidth) / effectiveHeight);
  const height = isPortraitOrSquare
    ? evenFloor((shortSide * effectiveHeight) / effectiveWidth)
    : shortSide;

  return {
    name: tier.name,
    width,
    height,
    videoBitrateKbps: tier.videoBitrateKbps,
    maxrateKbps: tier.maxrateKbps,
    bufsizeKbps: tier.bufsizeKbps,
    profile: tier.profile,
    level: tier.level,
    codecString: tier.codecString,
  };
}

/**
 * The lowest-tier bitrate/profile/level/codec values are reused for the
 * degenerate sub-360p rung — it is, by construction, a lower resolution than
 * every defined tier, so the lowest tier's encode settings are the correct
 * fit. `RUNG_PROFILES[0]` is asserted to be the 360p tier by
 * `rendition-ladder.spec.ts`, so this never silently drifts if the table's
 * ordering ever changes.
 */
function buildDegenerateRung(
  effectiveWidth: number,
  effectiveHeight: number,
): RenditionLadderRung {
  const width = evenFloor(effectiveWidth);
  const height = evenFloor(effectiveHeight);
  const lowestTier = RUNG_PROFILES[0];

  return {
    name: `${Math.min(width, height)}p`,
    width,
    height,
    videoBitrateKbps: lowestTier.videoBitrateKbps,
    maxrateKbps: lowestTier.maxrateKbps,
    bufsizeKbps: lowestTier.bufsizeKbps,
    profile: lowestTier.profile,
    level: lowestTier.level,
    codecString: lowestTier.codecString,
  };
}
