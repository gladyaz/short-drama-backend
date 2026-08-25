/** Work unit "R2 MEDIA MIGRATION": the shapes the CLI reports and acts on. */

/** Why a row cannot be migrated as things stand. */
export type MigrationBlockedReason =
  | 'source_file_missing'
  | 'source_not_a_file'
  | 'source_too_large'
  | 'source_path_unsafe'
  | 'duplicate_destination_key';

/** One eligible row, resolved against local disk and (optionally) the bucket. */
export interface MigrationCandidate {
  videoId: string;
  seriesId: string;
  episodeNumber: number;
  /** The row's existing `storageKey`. Never modified by this migration. */
  storageKey: string;
  /** Absolute local path `storageKey` resolves to under `STORAGE_ROOT`. */
  sourcePath: string;
  /** Destination object key — `buildMigrationObjectKey(videoId)`. */
  objectKey: string;
  /** Local file size, or `null` when the file could not be stat'd. */
  sourceBytes: number | null;
  /** Set when this row cannot proceed; `null` when it is ready. */
  blockedReason: MigrationBlockedReason | null;
  /**
   * Whether the destination object was already present in the bucket at the
   * moment it was checked. `null` means "not checked" — inventory does not
   * contact R2 unless `--check-remote` is passed.
   */
  remoteExists: boolean | null;
  /** Byte length of the existing remote object, when one was found. */
  remoteBytes: number | null;
}

/** What one invocation did. Every mode returns this same shape. */
export interface MigrationReport {
  mode: 'inventory' | 'upload' | 'verify' | 'link';
  /** True whenever nothing was written — to the bucket or to the database. */
  dryRun: boolean;
  bucket: string | null;
  storageRoot: string;
  totalRowsConsidered: number;
  eligible: number;
  /** Rows already carrying an `objectStorageKey`; never touched. */
  alreadyLinked: number;
  ready: number;
  blocked: number;
  uploaded: number;
  skippedAlreadyUploaded: number;
  verifiedOk: number;
  verifiedMismatch: number;
  linked: number;
  candidates: MigrationCandidate[];
  /** Human-readable problems worth surfacing above the per-row detail. */
  warnings: string[];
}
