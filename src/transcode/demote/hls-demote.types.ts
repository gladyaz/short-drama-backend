/**
 * Work unit "HLS DEMOTE": the plain-data contract between
 * `HlsDemoteService` (which decides and, only under `--apply`, writes) and
 * `run-hls-demote-cli.ts` (which prints). No Prisma types leak across this
 * boundary, matching `series-cover-orphan.types.ts`'s existing precedent.
 *
 * ## Why DEMOTE and not ROLLBACK
 *
 * There is no previous-generation state anywhere in this schema to roll back
 * TO. `TranscodeIntentService.promoteIfCurrent` overwrites `hlsMasterKey`,
 * `hlsRenditions` and `transcodeProfileVersion` IN PLACE; no history table,
 * audit row, or prior-value column exists, and nothing else in the codebase
 * ever writes `hlsMasterKey`. The only physical trace of a superseded
 * generation is its objects under `admin-media/<id>/hls/<old-prefix>/`, and
 * `TranscodeJanitorService.cleanupOrphanStaging` reclaims those once they
 * fall outside the grace window — so even that trace is deliberately
 * transient and must never be treated as restorable state.
 *
 * This command therefore does the one truthful thing available: it stops the
 * row ADVERTISING the bad generation, and lets `VideosService.getPlaybackUrl`
 * fall back through the pre-existing, unchanged R2/local resolution. It
 * invents no previous generation, and it deletes nothing.
 */

/** Every reason this command refuses, all of them ZERO-mutation outcomes. */
export type HlsDemoteRefusalCode =
  /** No `Video` row with that id. */
  | 'ROW_NOT_FOUND'
  /** `processingState IS NULL` — a legacy/local row the HLS pipeline never touched. */
  | 'NOT_AN_HLS_PIPELINE_ROW'
  /** The row is not `ready` (e.g. a re-transcode is in flight). While it is not `ready` it is not advertising HLS at all — see `VideosService.tryBuildHlsPlaybackResponse`. */
  | 'NOT_READY'
  /** `hlsMasterKey IS NULL` — nothing is being advertised. Also the idempotent answer to a repeated demote. */
  | 'NO_ACTIVE_HLS_GENERATION'
  /** `--generation` does not equal the row's CURRENT `processingVersion`: a stale operator command. */
  | 'GENERATION_MISMATCH'
  /** The live pointer's prefix does not carry `v<generation>-` — it belongs to some other generation than the one named. */
  | 'GENERATION_POINTER_MISMATCH'
  /** The live pointer does not live under THIS video's own `admin-media/<id>/hls/` home. */
  | 'MASTER_KEY_FOREIGN'
  /** Demoting would leave the row with no playable source at all, and `--allow-unplayable` was not given. */
  | 'NO_PLAYBACK_FALLBACK'
  /** The guarded write matched zero rows: the row changed between the read and the write. */
  | 'CAS_LOST';

/** What `GET /videos/:id/playback` would answer once the demotion lands. */
export type HlsDemotePlaybackOutcome =
  | { kind: 'r2'; objectStorageKey: string; sourceObjectPresent: boolean }
  | { kind: 'local'; storageKey: string }
  | { kind: 'unavailable' };

/** The row's live state as read at decision time — printed verbatim so an operator can compare it against their own expectation. */
export interface HlsDemoteCurrentState {
  processingState: string | null;
  processingVersion: number;
  hlsMasterKey: string | null;
  transcodeProfileVersion: string | null;
  lifecycleState: string;
  renditions: HlsDemoteRendition[];
  objectStorageKey: string | null;
  storageKey: string;
}

export interface HlsDemoteRendition {
  name: string;
  width: number;
  height: number;
}

/** Exactly what a demotion would stop advertising, and what it would leave alone. */
export interface HlsDemotePlan {
  /** The `hlsMasterKey` value the guarded write compares against and clears. */
  masterKey: string;
  /** The immutable generation prefix that owns it — printed so an operator can capture the objects BEFORE applying. */
  generationPrefix: string;
  /** The renditions that stop being advertised. Storage is NOT touched for any of them. */
  renditions: HlsDemoteRendition[];
  /** Object keys this command guarantees it never reads for mutation and never deletes. */
  untouchedObjects: string[];
  /** The truthful post-demotion playback answer, derived from this row's own columns. */
  resultingPlayback: HlsDemotePlaybackOutcome;
}

export interface HlsDemoteReport {
  generatedAt: Date;
  /** `false` for a dry run — the default. */
  apply: boolean;
  videoId: string;
  expectedGeneration: number;
  allowUnplayable: boolean;
  /** Present unless the row could not be read at all (`ROW_NOT_FOUND`). */
  current?: HlsDemoteCurrentState;
  /** Present only when every safety gate passed. */
  plan?: HlsDemotePlan;
  /** Set on any refusal. Mutually exclusive with `demoted: true`. */
  refusal?: { code: HlsDemoteRefusalCode; detail: string };
  /** `true` only when an `--apply` run's guarded write actually matched the row. */
  demoted: boolean;
}
