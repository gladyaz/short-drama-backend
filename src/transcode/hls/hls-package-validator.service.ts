import { readFile, stat } from 'fs/promises';
import { Inject, Injectable } from '@nestjs/common';
import { resolveSafeStoragePath } from '../../videos/storage-path.util';
import { HLS_SEGMENT_SECONDS } from './hls-profile.constants';
import { HLS_DURATION_TOLERANCE_SECONDS } from './hls.constants';
import { HLS_PROBE_CLIENT } from './hls.types';
import type {
  HlsPackageValidationIssue,
  HlsPackageValidationResult,
  HlsProbeClient,
  HlsRungArtifact,
  HlsSourceProbe,
  RenditionLadderResult,
} from './hls.types';

/**
 * Slice 11O — the binding local-validation checklist (approval binding
 * constraint 6: "FULL local validation before any R2 byte ... Local failure
 * ⇒ STOP, no R2 contact"). Returns a structured `{valid, issues}` result
 * rather than throwing on an expected validation failure, so every check can
 * be exercised independently and `HlsSmokeRunner` can decide what to do with
 * a failed result (stop before any upload) without a `try/catch` per rule.
 *
 * Checks performed (each maps to a named test in `hls-package-validator.service.spec.ts`):
 * 1. `master.m3u8` parses and is non-empty.
 * 2. Every variant playlist the master references exists on disk.
 * 3. Every init segment / media segment each variant references exists on disk.
 * 4. Every resolved path stays inside `packageRoot` — reuses
 *    `resolveSafeStoragePath` (`../../videos/storage-path.util.ts`), the
 *    SAME path-traversal guard the rest of this codebase uses, so a
 *    malicious/corrupted relative reference (e.g. `../../etc/passwd`)
 *    inside a playlist is rejected rather than resolved.
 * 5. Every referenced media file is ffprobe-inspectable (via the injected
 *    `HlsProbeClient`, probed through the `.m3u8` — see
 *    `HlsEncoderClient`'s doc comment for why the `.m3u8`, not the bare
 *    `init.mp4`, is what ffprobe can fully inspect).
 * 6. Duration ≈ source duration (tolerance `HLS_DURATION_TOLERANCE_SECONDS`
 *    — segments round up to 4 s boundaries, so the produced duration can
 *    legitimately exceed the source by nearly one segment length).
 * 7. Each rung's probed dimensions exactly match its claimed (already
 *    upscale-checked) ladder dimensions — this transitively re-proves
 *    "no upscale" against the REAL produced artifact, not just the ladder's
 *    own claim.
 * 8. Segment count is sane: `duration / 4s`, ±1.
 * 9. No zero-byte artifact (playlist, init segment, or media segment).
 * 10. The master references EXACTLY the produced rungs — no more, no fewer.
 */
@Injectable()
export class HlsPackageValidator {
  constructor(
    @Inject(HLS_PROBE_CLIENT) private readonly probeClient: HlsProbeClient,
  ) {}

  async validate(
    packageRoot: string,
    ladder: RenditionLadderResult,
    artifacts: HlsRungArtifact[],
    sourceDurationSeconds: number,
    masterPlaylistText: string,
  ): Promise<HlsPackageValidationResult> {
    const issues: HlsPackageValidationIssue[] = [];

    if (!masterPlaylistText.trim().startsWith('#EXTM3U')) {
      issues.push({
        code: 'MASTER_PLAYLIST_UNPARSEABLE',
        message: 'master.m3u8 does not start with #EXTM3U',
      });
      return { valid: false, issues };
    }

    const masterVariantUris = parseMasterVariantUris(masterPlaylistText);
    const expectedUris = artifacts.map((a) => a.playlistRelativePath).sort();
    const actualUris = [...masterVariantUris].sort();

    if (JSON.stringify(expectedUris) !== JSON.stringify(actualUris)) {
      issues.push({
        code: 'MASTER_PLAYLIST_RUNG_MISMATCH',
        message: `master.m3u8 references [${actualUris.join(', ')}], expected exactly [${expectedUris.join(', ')}]`,
      });
    }

    for (const artifact of artifacts) {
      await this.validateVariant(
        packageRoot,
        artifact,
        ladder,
        sourceDurationSeconds,
        issues,
      );
    }

    return { valid: issues.length === 0, issues };
  }

  private async validateVariant(
    packageRoot: string,
    artifact: HlsRungArtifact,
    ladder: RenditionLadderResult,
    sourceDurationSeconds: number,
    issues: HlsPackageValidationIssue[],
  ): Promise<void> {
    const variantPath = this.resolveWithinRoot(
      packageRoot,
      artifact.playlistRelativePath,
      issues,
    );
    if (variantPath === undefined) {
      return;
    }

    const variantText = await this.readNonEmptyFile(
      variantPath,
      `variant playlist "${artifact.playlistRelativePath}"`,
      issues,
    );
    if (variantText === undefined) {
      return;
    }

    const { mapUri, segmentUris } = parseVariantReferences(variantText);

    if (mapUri === undefined) {
      issues.push({
        code: 'VARIANT_MISSING_MAP',
        message: `Variant "${artifact.rung.name}" has no #EXT-X-MAP init segment reference`,
      });
    } else {
      await this.assertNonZeroArtifact(
        packageRoot,
        `${artifact.rung.name}/${mapUri}`,
        issues,
      );
    }

    for (const segmentUri of segmentUris) {
      await this.assertNonZeroArtifact(
        packageRoot,
        `${artifact.rung.name}/${segmentUri}`,
        issues,
      );
    }

    const expectedSegmentCount = Math.max(
      1,
      Math.ceil(sourceDurationSeconds / HLS_SEGMENT_SECONDS),
    );
    if (Math.abs(segmentUris.length - expectedSegmentCount) > 1) {
      issues.push({
        code: 'SEGMENT_COUNT_INSANE',
        message: `Variant "${artifact.rung.name}" has ${segmentUris.length} segments, expected ~${expectedSegmentCount} (duration/${HLS_SEGMENT_SECONDS}s ±1)`,
      });
    }

    await this.assertProbeMatches(
      variantPath,
      artifact,
      ladder,
      sourceDurationSeconds,
      issues,
    );
  }

  private async assertProbeMatches(
    variantPath: string,
    artifact: HlsRungArtifact,
    ladder: RenditionLadderResult,
    sourceDurationSeconds: number,
    issues: HlsPackageValidationIssue[],
  ): Promise<void> {
    let probed: HlsSourceProbe;
    try {
      probed = await this.probeClient.probe(variantPath);
    } catch (error) {
      issues.push({
        code: 'VARIANT_NOT_PROBEABLE',
        message: `Variant "${artifact.rung.name}" is not ffprobe-inspectable: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    if (
      probed.width !== artifact.rung.width ||
      probed.height !== artifact.rung.height
    ) {
      issues.push({
        code: 'DIMENSION_MISMATCH',
        message: `Variant "${artifact.rung.name}" probed as ${probed.width}x${probed.height}, expected ${artifact.rung.width}x${artifact.rung.height}`,
      });
    }

    // Defense-in-depth "no upscale" check against the real produced
    // artifact's pixel count vs. the source's effective pixel count — the
    // ladder function's own tests already prove the CLAIMED dimensions
    // never upscale; this proves the ACTUALLY PRODUCED file matches that
    // claim.
    const rungPixels = artifact.rung.width * artifact.rung.height;
    const sourcePixels = ladder.effectiveWidth * ladder.effectiveHeight;
    if (rungPixels > sourcePixels) {
      issues.push({
        code: 'UPSCALE_DETECTED',
        message: `Variant "${artifact.rung.name}" (${artifact.rung.width}x${artifact.rung.height}) has more pixels than the source (${ladder.effectiveWidth}x${ladder.effectiveHeight})`,
      });
    }

    if (
      Math.abs(probed.durationSeconds - sourceDurationSeconds) >
      HLS_DURATION_TOLERANCE_SECONDS
    ) {
      issues.push({
        code: 'DURATION_MISMATCH',
        message: `Variant "${artifact.rung.name}" duration ${probed.durationSeconds}s is not within ${HLS_DURATION_TOLERANCE_SECONDS}s of source duration ${sourceDurationSeconds}s`,
      });
    }
  }

  private async assertNonZeroArtifact(
    packageRoot: string,
    relativePath: string,
    issues: HlsPackageValidationIssue[],
  ): Promise<void> {
    const path = this.resolveWithinRoot(packageRoot, relativePath, issues);
    if (path === undefined) {
      return;
    }

    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(path);
    } catch {
      issues.push({
        code: 'ARTIFACT_MISSING',
        message: `Referenced artifact "${relativePath}" does not exist on disk`,
      });
      return;
    }

    if (stats.size === 0) {
      issues.push({
        code: 'ARTIFACT_ZERO_BYTES',
        message: `Referenced artifact "${relativePath}" is zero bytes`,
      });
    }
  }

  private async readNonEmptyFile(
    path: string,
    label: string,
    issues: HlsPackageValidationIssue[],
  ): Promise<string | undefined> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      issues.push({
        code: 'ARTIFACT_MISSING',
        message: `${label} does not exist on disk`,
      });
      return undefined;
    }

    if (text.trim().length === 0) {
      issues.push({
        code: 'ARTIFACT_ZERO_BYTES',
        message: `${label} is empty`,
      });
      return undefined;
    }

    return text;
  }

  /**
   * The traversal test surface (approval binding constraint 13 / test 8):
   * every path this validator ever touches is resolved through
   * `resolveSafeStoragePath`, which throws for anything that would escape
   * `packageRoot`. Caught here and turned into a structured issue (rather
   * than letting `validate()` throw) so a single malformed/malicious
   * playlist reference fails the package validation cleanly instead of
   * crashing the whole run.
   */
  private resolveWithinRoot(
    packageRoot: string,
    relativePath: string,
    issues: HlsPackageValidationIssue[],
  ): string | undefined {
    try {
      return resolveSafeStoragePath(packageRoot, relativePath);
    } catch {
      issues.push({
        code: 'PATH_OUTSIDE_PACKAGE_ROOT',
        message: `Resolved path for "${relativePath}" escapes the package root`,
      });
      return undefined;
    }
  }
}

function parseMasterVariantUris(masterPlaylistText: string): string[] {
  const lines = masterPlaylistText.split('\n').map((line) => line.trim());
  const uris: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const uri = lines[i + 1];
      if (uri !== undefined && uri.length > 0 && !uri.startsWith('#')) {
        uris.push(uri);
      }
    }
  }

  return uris;
}

function parseVariantReferences(variantPlaylistText: string): {
  mapUri: string | undefined;
  segmentUris: string[];
} {
  const lines = variantPlaylistText.split('\n').map((line) => line.trim());
  const mapLine = lines.find((line) => line.startsWith('#EXT-X-MAP'));
  const mapUriMatch = mapLine ? /URI="([^"]+)"/.exec(mapLine) : null;

  const segmentUris = lines.filter(
    (line) => line.length > 0 && !line.startsWith('#'),
  );

  return { mapUri: mapUriMatch?.[1], segmentUris };
}
