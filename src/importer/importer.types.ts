/**
 * Phase 11, work unit 11D-1: the technical metadata ffprobe extracts from a
 * source video file.
 */
export interface FfprobeMetadata {
  durationSeconds: number;
  width: number;
  height: number;
}

/**
 * Injectable ffprobe abstraction. `ImporterModule` provides `FfprobeCliClient`
 * (shells out to the real `ffprobe` binary) as the default implementation;
 * every test in this slice injects a mock/fixture implementation instead —
 * no test requires `ffmpeg` to be installed, and none ever runs against the
 * real company library (see DECISIONS.md, work unit 11D-1-real, out of
 * scope here).
 */
export interface FfprobeClient {
  probe(sourcePath: string): Promise<FfprobeMetadata>;
}

/** Phase 11, work unit 11D-1: DI token for the injected `FfprobeClient`. */
export const FFPROBE_CLIENT = 'IMPORTER_FFPROBE_CLIENT';

/**
 * One row of an import manifest — the narrative/catalog metadata ffprobe
 * cannot provide, mirroring `VideoRecord`'s required fields (see
 * `video.types.ts`) minus `likeCount` (always starts at 0 on create, and is
 * never touched by a re-import) and `durationSeconds`/`width`/`height`
 * (always ffprobe-derived, never manifest-supplied).
 */
export interface ImportManifestItem {
  /** Stable identity — re-running the import with the same `id` updates the existing row instead of duplicating it. */
  id: string;
  seriesId: string;
  title: string;
  episodeNumber: number;
  channelName: string;
  caption: string;
  category: string;
  /** Path relative to STORAGE_ROOT, passed to `FfprobeClient.probe` and persisted as `Video.storageKey` — this importer targets the existing local-file catalog convention (`prisma/seed.ts`), not the 11B-3 object-storage pipeline. */
  storageKey: string;
  sourceLanguage: string;
  hasEmbeddedIndonesianSubtitle: boolean;
}

export type ImportItemStatus = 'created' | 'updated' | 'failed';

export interface ImportItemSuccess {
  id: string;
  status: 'created' | 'updated';
  metadata: FfprobeMetadata;
}

export interface ImportItemFailure {
  id: string;
  status: 'failed';
  attempts: number;
  error: string;
}

export type ImportItemResult = ImportItemSuccess | ImportItemFailure;

export interface ImportBatchResult {
  results: ImportItemResult[];
  succeeded: number;
  failed: number;
}

export interface ImportBatchOptions {
  /** Max ffprobe attempts per item before it is reported as failed. Default 3. */
  maxAttempts?: number;
}
