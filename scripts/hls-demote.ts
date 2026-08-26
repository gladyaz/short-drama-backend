import 'dotenv/config';
import { runHlsDemoteCli } from '../src/transcode/demote/run-hls-demote-cli';

/**
 * Work unit "HLS DEMOTE": the ONLY way to invoke `HlsDemoteService` at all.
 * Nothing in this repo runs it automatically — no cron, no scheduler
 * registration, no `package.json` pre/post hook, no CI step, and no
 * application boot path reaches it. A human types the command.
 *
 * DEFAULT (no `--apply`): a DRY RUN. Prints the target row's current state,
 * the exact master key and generation prefix that would stop being
 * advertised, the renditions that go with them, the objects it will not
 * touch, and what `GET /videos/:id/playback` would answer afterwards. Writes
 * nothing:
 *
 *   npm run hls:demote -- --video-id video-101-01 --generation 3
 *
 * MUTATING (`--apply`): performs one guarded `updateMany` that clears the
 * live pointer. Storage is still never touched:
 *
 *   npm run hls:demote -- --video-id video-101-01 --generation 3 --apply
 *
 * Deliberately does NOT require `TRANSCODE_ENABLED` — see
 * `HlsDemoteCliModule`'s doc comment.
 */
runHlsDemoteCli(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
