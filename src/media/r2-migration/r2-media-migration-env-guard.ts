/**
 * Work unit "R2 MEDIA MIGRATION": the gate a run must pass before it may
 * write anything — to the bucket (`--upload`) or to the database
 * (`--link`).
 *
 * Deliberately the SAME SHAPE as
 * `src/series/cover-orphans/series-cover-orphan-env-guard.ts`, and for the
 * same reason: an operator must independently restate WHICH BUCKET this
 * specific run is allowed to act on, so that a shell that still has a
 * different deployment's `OBJECT_STORAGE_BUCKET` exported cannot quietly
 * write into it.
 *
 * It is NOT imported from that file. That guard's own doc comment declares
 * it specific to the retention/orphan job, and its allowlist
 * (`NODE_ENV` ∈ {development, test}) is deliberately WRONG here: this
 * migration's whole purpose is to populate a PRODUCTION bucket, so gating it
 * on a non-production `NODE_ENV` would make the tool unusable for the one
 * job it exists to do. The bucket-restatement half is what carries the
 * safety here, and it works identically in every environment.
 */

/**
 * The variable an operator must set, to exactly the same value as
 * `OBJECT_STORAGE_BUCKET`, to authorize a writing run.
 */
export const R2_MIGRATION_APPLY_BUCKET_ENV = 'R2_MEDIA_MIGRATION_APPLY_BUCKET';

export interface MigrationApplyGateInput {
  /** The bucket the app is actually configured against. */
  configuredBucket: string;
  /** The operator's restatement, from `R2_MEDIA_MIGRATION_APPLY_BUCKET`. */
  restatedBucket: string | undefined;
  /** `StorageConfig.driver` — writing runs require the `r2` driver. */
  storageDriver: string;
}

/**
 * Throws unless this run may write. Returns normally (void) when it may.
 *
 * Three independent conditions, each closing a different mistake:
 *
 *  1. `STORAGE_DRIVER=r2`. Under the `local` driver `StorageService` is
 *     configured from empty credentials, so an upload would fail anyway —
 *     but it would fail after the run had already started reading files and
 *     reporting progress, which reads as "the migration is running" when it
 *     is not. Refuse up front instead.
 *  2. A non-empty `OBJECT_STORAGE_BUCKET`. Without it every S3 command
 *     would target an empty bucket name.
 *  3. The restatement must MATCH. This is the real gate. It is not a
 *     confirmation prompt (which a script would paste past) — it requires
 *     the operator to have looked up the bucket name and typed it for this
 *     run.
 *
 * Bucket NAMES appear in the error messages. A bucket name is not a
 * credential — it is already visible in `.env.example`, in
 * `/health/details`, and in every presigned URL — and naming both sides of a
 * mismatch is the only way the message is actionable. No key, secret, or
 * endpoint is ever read here.
 */
export function assertMigrationApplyAllowed(
  input: MigrationApplyGateInput,
): void {
  if (input.storageDriver !== 'r2') {
    throw new Error(
      `Refusing to write: STORAGE_DRIVER is ${JSON.stringify(input.storageDriver)}, not "r2". ` +
        'A writing migration run uploads to object storage, so it requires the r2 driver. ' +
        'Re-run without --upload/--link for a read-only inventory, which works under either driver.',
    );
  }

  if (!input.configuredBucket) {
    throw new Error(
      'Refusing to write: OBJECT_STORAGE_BUCKET is not set. ' +
        'A writing migration run must know which bucket it is writing to.',
    );
  }

  if (!input.restatedBucket) {
    throw new Error(
      `Refusing to write: ${R2_MIGRATION_APPLY_BUCKET_ENV} is not set. ` +
        'A writing run requires you to restate the target bucket independently, so a ' +
        "shell still holding another deployment's OBJECT_STORAGE_BUCKET cannot write into it. " +
        `Re-run with ${R2_MIGRATION_APPLY_BUCKET_ENV}="${input.configuredBucket}".`,
    );
  }

  if (input.restatedBucket !== input.configuredBucket) {
    throw new Error(
      `Refusing to write: ${R2_MIGRATION_APPLY_BUCKET_ENV}=${JSON.stringify(input.restatedBucket)} ` +
        `does not match OBJECT_STORAGE_BUCKET=${JSON.stringify(input.configuredBucket)}. ` +
        'These must be the same bucket. A mismatch means one of the two is not the bucket you think it is.',
    );
  }
}
