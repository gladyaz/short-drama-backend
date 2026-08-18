import { redactSensitiveText } from '../../common/logging/redact';

/**
 * Slice "SERIES COVER ORPHAN CLEANUP LIFECYCLE": the production guard for
 * the sweep's destructive (`apply: true`) mode.
 *
 * Modeled on `retention/retention-env-guard.ts` — same fail-closed ALLOWLIST
 * shape, same "call before any I/O" contract, same `redactSensitiveText`
 * defense in depth — but deliberately a SEPARATE, independently maintained
 * gate rather than a call into that file. The two protect different
 * resources: the retention guard proves "this is the disposable TEST
 * DATABASE", which says nothing whatsoever about which R2 BUCKET the process
 * is pointed at. A destructive sweep here removes objects from a bucket,
 * so it needs a bucket-identity gate of its own. Neither file is implemented
 * in terms of the other, exactly as `env.validation.ts` and
 * `retention-env-guard.ts` are already kept independent.
 *
 * Three gates, ALL of which must pass:
 *
 *  1. `NODE_ENV` is exactly one of `SERIES_COVER_ORPHAN_ALLOWED_NODE_ENVS`.
 *     An ALLOWLIST, so unset, `''`, `'produciton'`, or any unrecognized
 *     value is UNSAFE by default — never "probably fine because it isn't
 *     literally the word production".
 *  2. `OBJECT_STORAGE_BUCKET` is set and non-empty. There is no meaningful
 *     "sweep the default bucket" — an unnamed bucket is a refusal, not a
 *     fallback.
 *  3. `SERIES_COVER_ORPHAN_APPLY_BUCKET` is set and EXACTLY equals
 *     `OBJECT_STORAGE_BUCKET`. This is the storage analogue of the retention
 *     guard's `DATABASE_URL` === `DATABASE_URL_TEST` identity check, and it
 *     exists for the identical reason: `NODE_ENV=development` is the normal
 *     state of a laptop whose `.env` legitimately points at the REAL shared
 *     dev bucket, so `NODE_ENV` alone must never be sufficient. Requiring
 *     the operator to independently restate the bucket name they mean makes
 *     `--apply` impossible to trigger by ambient configuration alone: it can
 *     only ever act on a bucket a human typed out for this specific run.
 *
 * Every failure is a throw. There is no "warn and continue" path.
 */
export const SERIES_COVER_ORPHAN_ALLOWED_NODE_ENVS = [
  'development',
  'test',
] as const;

export type SeriesCoverOrphanAllowedNodeEnv =
  (typeof SERIES_COVER_ORPHAN_ALLOWED_NODE_ENVS)[number];

/** Name of the operator-confirmation variable gate 3 above requires. */
export const SERIES_COVER_ORPHAN_APPLY_BUCKET_ENV =
  'SERIES_COVER_ORPHAN_APPLY_BUCKET';

/**
 * Throws unless every gate in this file's doc comment passes. Callers MUST
 * invoke this BEFORE issuing a single storage or database call for the
 * destructive path — `SeriesCoverOrphanService.run` calls it as its very
 * first action, and `runSeriesCoverOrphansCli` calls it again before the
 * Nest context (and therefore `PrismaService`/`S3Client`) is constructed at
 * all — so a refusal means zero I/O happened for this run, not merely "we
 * decided to stop after already listing the bucket".
 *
 * Defaults read the LIVE `process.env` at call time (never a value captured
 * at import time); the parameters exist so the spec can drive every branch
 * without mutating global state.
 */
export function assertSeriesCoverOrphanApplyAllowed(
  nodeEnv: string | undefined = process.env.NODE_ENV,
  bucket: string | undefined = process.env.OBJECT_STORAGE_BUCKET,
  confirmedBucket: string | undefined = process.env[
    SERIES_COVER_ORPHAN_APPLY_BUCKET_ENV
  ],
): void {
  const isAllowedNodeEnv = (
    SERIES_COVER_ORPHAN_ALLOWED_NODE_ENVS as readonly string[]
  ).includes(nodeEnv ?? '');

  if (!isAllowedNodeEnv) {
    refuse(
      `NODE_ENV=${JSON.stringify(nodeEnv ?? null)} is not one of the ` +
        `explicitly allowed values (${SERIES_COVER_ORPHAN_ALLOWED_NODE_ENVS.join(', ')}). ` +
        'This is a fail-closed ALLOWLIST, not an "!== production" check — an ' +
        'unset, misspelled, or unrecognized NODE_ENV is treated as unsafe.',
    );
  }

  if (!bucket) {
    refuse(
      'OBJECT_STORAGE_BUCKET is unset or empty, so there is no bucket ' +
        'identity to confirm. A destructive sweep requires an explicitly ' +
        'configured bucket; there is no default.',
    );
  }

  if (!confirmedBucket) {
    refuse(
      `${SERIES_COVER_ORPHAN_APPLY_BUCKET_ENV} is unset or empty. A ` +
        'destructive sweep requires the operator to independently restate ' +
        'the bucket name for this specific run, so --apply can never act on ' +
        'whatever bucket the ambient environment happens to point at.',
    );
  }

  if (confirmedBucket !== bucket) {
    refuse(
      `${SERIES_COVER_ORPHAN_APPLY_BUCKET_ENV}="${confirmedBucket}" does not ` +
        `match OBJECT_STORAGE_BUCKET="${bucket}". The confirmation must name ` +
        'exactly the bucket this process is configured against.',
    );
  }
}

/**
 * Deliberately a top-level `never`-returning function rather than an inline
 * throw or a closure — TypeScript narrows `string | undefined` to `string`
 * after an `if (!value) { ... }` guard only when the guard calls a
 * statically-known `never`-returning function. Same reason
 * `retention-env-guard.ts` keeps its own `refuseDestructiveRetentionDatabase`
 * at module scope.
 *
 * A bucket NAME is not itself a credential (this repo's `redact.ts` already
 * treats scheme/host/database-name as non-sensitive debugging aid), but the
 * assembled message is still passed through `redactSensitiveText` so a
 * future edit that accidentally interpolates an access key or endpoint URL
 * here cannot leak it.
 */
function refuse(reason: string): never {
  throw new Error(
    redactSensitiveText(
      'Refusing to run the Series cover orphan sweep destructively ' +
        `(--apply): ${reason} Re-run without --apply for a dry run, which ` +
        'never removes anything and needs none of these gates.',
    ),
  );
}
