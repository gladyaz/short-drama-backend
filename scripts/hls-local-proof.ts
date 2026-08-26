import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from '../src/worker/worker.module';
import { HlsSmokeRunner } from '../src/transcode/hls/hls-smoke-runner.service';

/**
 * Slice 11O — the orchestrator's one-shot "full 4-rung local proof" runner.
 * Boots the real `WorkerModule.register()` DYNAMIC module (Slice 11P turned
 * `WorkerModule` into a `@Module({})` shell whose only real definition comes
 * from `register()`; passing the bare class here silently produced an EMPTY
 * context and an `Nest could not find HlsSmokeRunner` failure) — real
 * ffmpeg/ffprobe CLI clients, nothing
 * mocked), runs `HlsSmokeRunner.run()` with `upload: false` (the default —
 * this script NEVER touches the network or R2, regardless of `.env`
 * contents), and prints a JSON summary: wall-clock, produced file count,
 * total bytes, and the local validator's verdict.
 *
 * Usage:
 *
 *   npm run hls:local-proof
 *   npm run hls:local-proof -- --keep
 *
 * `--keep` retains the produced package directory instead of deleting it, and
 * prints its absolute path as `packageRoot` in the JSON summary — for a manual
 * investigation that needs to `ffprobe` each rendition or serve the manifests
 * to a real HLS client. The caller must delete that directory afterwards; it
 * holds several megabytes per run. Without the flag, behavior is exactly as
 * before (the package is always removed).
 *
 * Exits `0` when the local package validated successfully, `1` otherwise
 * (including any thrown error, e.g. an ffmpeg failure) — so this script's
 * own exit code is a meaningful pass/fail signal for the orchestrator
 * without needing to parse the JSON output.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(
    WorkerModule.register(),
    {
      logger: false,
    },
  );

  try {
    const runner = app.get(HlsSmokeRunner);
    const keepPackage = process.argv.includes('--keep');
    const result = await runner.run({ keepPackage });

    const summary = {
      wallClockMs: result.wallClockMs,
      // Only meaningful with `--keep`; without it this directory is already
      // gone by the time this line runs, so it is reported as `null` rather
      // than as a path that no longer exists.
      packageRoot: keepPackage ? result.packageRoot : null,
      sourceProbe: result.sourceProbe,
      ladderRungs: result.ladder.rungs.map((rung) => ({
        name: rung.name,
        width: rung.width,
        height: rung.height,
        codecString: rung.codecString,
      })),
      rungFileCounts: result.rungArtifacts.map((artifact) => ({
        name: artifact.rung.name,
        segmentCount: artifact.segmentCount,
        totalMediaBytes: artifact.totalMediaBytes,
      })),
      totalLocalFileCount: result.totalLocalFileCount,
      totalLocalBytes: result.totalLocalBytes,
      validation: result.validation,
    };

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary, null, 2));

    process.exitCode = result.validation.valid ? 0 : 1;
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});
