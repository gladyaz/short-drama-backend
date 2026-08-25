/**
 * Work unit "R2 MEDIA MIGRATION": the deterministic row → object-key rule,
 * and the bounds that keep a migration run safe to start and safe to
 * restart.
 */

/**
 * Builds the destination object key for one video row.
 *
 * DERIVED FROM THE PRIMARY KEY, NEVER FROM THE FILENAME. Three properties
 * fall out of that choice, and all three are load-bearing:
 *
 *  1. UNIQUENESS IS STRUCTURAL. `Video.id` is the primary key, so two rows
 *     cannot produce the same destination key. A filename-derived scheme
 *     could: `Series 104/1_subtitled.mp4` and `Series-105/1_subtitled.mp4`
 *     share a basename, and this catalog contains exactly that collision
 *     four times over.
 *  2. IT IS ASCII-SAFE. `series-101`'s ten episodes are named
 *     `第1集_subtitled.mp4` … `第10集_subtitled.mp4`. Copying those bytes
 *     into an object key would work, but every later `curl`, log line,
 *     bucket-console URL and signed URL would carry percent-encoded CJK —
 *     a permanent operational tax for no benefit.
 *  3. IT MATCHES WHAT ALREADY EXISTS. The two QA-fixture rows already in
 *     this bucket use `admin-media/<id>/source`, written by the admin
 *     upload flow. Reusing that exact shape means one convention in the
 *     bucket, not two.
 *
 * The original filename is NOT lost: `Video.storageKey` still holds it, and
 * this migration never writes to that column.
 */
export function buildMigrationObjectKey(videoId: string): string {
  return `admin-media/${videoId}/source`;
}

/**
 * Every migrated object is an MP4 — the local catalog is `*_subtitled.mp4`
 * exclusively. Set explicitly so the object carries a correct `Content-Type`
 * rather than R2's `application/octet-stream` default, which some players
 * refuse to progressive-download.
 */
export const MIGRATION_CONTENT_TYPE = 'video/mp4';

/**
 * Refuse to buffer a source file larger than this into memory.
 *
 * `StorageService.putObject` takes a `Buffer`, so the whole file is resident
 * during its upload. The real catalog's largest episode is ~45 MiB and the
 * mean is ~19 MiB, so 256 MiB is far above anything this migration will
 * meet — it exists so that an unexpectedly huge file is REPORTED as a
 * skipped, named problem instead of taking the process down with an
 * out-of-memory crash midway through a batch, which is the failure mode
 * that makes a restart hard to reason about.
 */
export const MIGRATION_MAX_SOURCE_BYTES = 256 * 1024 * 1024;

/**
 * Upper bound on rows one invocation will act on. A bound, not a page size:
 * this catalog holds 40 eligible rows, so the default never truncates it,
 * but an unbounded `findMany` against a table that grew unexpectedly is how
 * a "quick migration" becomes an unplanned multi-hour transfer.
 */
export const MIGRATION_DEFAULT_LIMIT = 200;
