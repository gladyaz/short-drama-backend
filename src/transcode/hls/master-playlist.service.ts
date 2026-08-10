import { writeFile } from 'fs/promises';
import { join } from 'path';
import { Injectable } from '@nestjs/common';
import { HLS_AUDIO_CODEC_STRING } from './hls-profile.constants';
import { HLS_MASTER_PLAYLIST_FILENAME } from './hls.constants';
import { HlsRungArtifact, RenditionLadderResult } from './hls.types';

/** Container/segmenting overhead margin applied on top of the declared peak bitrate. */
const CONTAINER_OVERHEAD_MULTIPLIER = 1.05;

export interface MasterPlaylistBuildResult {
  path: string;
  text: string;
}

/**
 * Slice 11O — writes `master.m3u8` from the ACTUALLY produced rungs only
 * (approval binding constraint 5: "master must advertise exactly what was
 * produced"). Pure computation + a single `fs.writeFile`; no ffmpeg/ffprobe
 * involved, so this is unit-tested directly with hand-built artifact
 * fixtures.
 *
 * - **BANDWIDTH** (peak, required by the HLS spec): `(maxrate + audio
 *   bitrate) * 1.05` — the 5% margin accounts for container/segmenting
 *   overhead on top of the VBV-enforced peak, per the architecture's
 *   "peak: maxrate+audio+~5% container" note.
 * - **AVERAGE-BANDWIDTH** (measured, optional but included when
 *   supported): the rung's ACTUAL produced media bytes (init + every
 *   segment, from `HlsRungArtifact.totalMediaBytes`) × 8, divided by the
 *   package's real duration — i.e. what the rung really weighed, not a
 *   theoretical estimate.
 * - **CODECS**: the rung's exact `avc1.<profile><level>` token, plus
 *   `mp4a.40.2` ONLY when the ladder says this source has audio — a
 *   no-audio source's master never references an audio codec.
 * - **FRAME-RATE**: the ladder's capped output fps, formatted with up to 3
 *   decimal places (trailing zeros trimmed).
 */
@Injectable()
export class MasterPlaylistService {
  build(
    packageRoot: string,
    ladder: RenditionLadderResult,
    artifacts: HlsRungArtifact[],
    durationSeconds: number,
  ): MasterPlaylistBuildResult {
    const lines: string[] = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-INDEPENDENT-SEGMENTS',
    ];

    for (const artifact of artifacts) {
      const { rung } = artifact;
      const peakBandwidth = Math.ceil(
        (rung.maxrateKbps * 1000 + audioBitrateBps(ladder.includeAudio)) *
          CONTAINER_OVERHEAD_MULTIPLIER,
      );
      const averageBandwidth = Math.round(
        (artifact.totalMediaBytes * 8) / durationSeconds,
      );
      const codecs = ladder.includeAudio
        ? `${rung.codecString},${HLS_AUDIO_CODEC_STRING}`
        : rung.codecString;

      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${peakBandwidth},AVERAGE-BANDWIDTH=${averageBandwidth},RESOLUTION=${rung.width}x${rung.height},CODECS="${codecs}",FRAME-RATE=${formatFrameRate(ladder.fps)}`,
      );
      lines.push(artifact.playlistRelativePath);
    }

    const text = `${lines.join('\n')}\n`;
    const path = join(packageRoot, HLS_MASTER_PLAYLIST_FILENAME);

    return { path, text };
  }

  async write(result: MasterPlaylistBuildResult): Promise<void> {
    await writeFile(result.path, result.text, 'utf8');
  }
}

function audioBitrateBps(includeAudio: boolean): number {
  return includeAudio ? 96_000 : 0;
}

function formatFrameRate(fps: number): string {
  return String(Number(fps.toFixed(3)));
}
