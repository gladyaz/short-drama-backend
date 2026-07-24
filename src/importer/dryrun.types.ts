import { FfprobeMetadata } from './importer.types';

/**
 * Phase 11, work unit 11D-1-dryrun: one discovered video file's dry-run
 * result — what a real 11D-1 import WOULD do with this file, computed
 * without writing anything.
 */
export interface DryRunItemBase {
  fileName: string;
  /** 1-based, natural-sort-ordered proposed episode number. */
  proposedEpisodeNumber: number;
  /** 0-based natural-sort position, mirroring `ImportBatchResult`'s `sortOrder` (`items[index] -> sortOrder: index`) convention. */
  proposedSortOrder: number;
  /**
   * The value a real 11D-1 import WOULD persist as `Video.storageKey`,
   * computed as this file's path relative to the passed `folderPath` — see
   * `MediaDryRunService`'s doc comment for the full convention note.
   */
  proposedStorageKey: string;
}

export interface DryRunItemSuccess extends DryRunItemBase {
  status: 'ok';
  metadata: FfprobeMetadata;
}

export interface DryRunItemFailure extends DryRunItemBase {
  status: 'probe_failed';
  attempts: number;
  error: string;
}

export type DryRunItemResult = DryRunItemSuccess | DryRunItemFailure;

export interface DryRunReport {
  folderPath: string;
  items: DryRunItemResult[];
  discoveredCount: number;
  succeeded: number;
  failed: number;
}

export interface DryRunOptions {
  /** Max ffprobe attempts per file before it is reported as `probe_failed`. Default 3. */
  maxAttempts?: number;
}
