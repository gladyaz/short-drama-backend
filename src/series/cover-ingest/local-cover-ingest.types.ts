import { StorageDriver } from '../../config/configuration';

/**
 * Work unit "LOCAL SERIES COVER ARTWORK": what one `covers:ingest` run was
 * asked to do.
 */
export interface LocalCoverIngestRunOptions {
  /** Directory of poster files, keyed by filename stem. */
  readonly sourceDir: string;
  /**
   * `false` (the default the CLI applies when `--apply` is absent) means a
   * DRY RUN: the report is fully populated, and not one byte is copied nor
   * one row updated.
   */
  readonly apply: boolean;
}

/**
 * What happened to ONE series.
 *
 * `skipped` and `failed` are deliberately distinct. `skipped` means the
 * catalog simply has no artwork for this series and nothing is wrong;
 * `failed` means an asset WAS found and could not be used, which is a defect
 * an operator must see rather than a quiet no-op. Collapsing them into one
 * status would make a corrupt poster indistinguishable from an absent one.
 */
export type LocalCoverIngestOutcome =
  | {
      readonly seriesId: string;
      readonly title: string;
      readonly status: 'skipped';
      readonly reason: string;
    }
  | {
      readonly seriesId: string;
      readonly title: string;
      readonly status: 'failed';
      readonly sourcePath: string;
      readonly reason: string;
    }
  | {
      readonly seriesId: string;
      readonly title: string;
      readonly status: 'would-ingest' | 'ingested';
      readonly sourcePath: string;
      readonly key: string;
      readonly contentType: string;
      readonly bytes: number;
      /**
       * The `coverImageKey` this row held BEFORE the run — `null` for a series
       * that had no artwork, or a superseded key for a replacement. Reported
       * so a replacement is visibly a replacement, and so the superseded
       * object can be recognised by the existing cover-orphan sweep.
       */
      readonly previousCoverImageKey: string | null;
    };

/** The whole run, including the configuration it actually resolved. */
export interface LocalCoverIngestReport {
  readonly driver: StorageDriver;
  readonly sourceDir: string;
  readonly localRoot: string;
  readonly applied: boolean;
  readonly outcomes: LocalCoverIngestOutcome[];
}
