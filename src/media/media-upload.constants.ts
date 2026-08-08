/**
 * Phase 11, work unit 11L-B2: named-constant ceiling for
 * `CreateMediaUploadDto.sizeBytes` (see `common/coding-style.md` — "no
 * hardcoded values", magic numbers get named constants).
 *
 * The work unit's own request framed this as "2 GiB (2147483648)". That
 * literal value is deliberately NOT used here: `Video.expectedSizeBytes`
 * (11L-B1) is a Prisma `Int` column — Postgres 4-byte `integer`, a 32-bit
 * SIGNED range of `-2147483648` to `2147483647`. `2147483648` is one byte
 * OVER that range. If `@Max` allowed it through, a request declaring
 * exactly `sizeBytes: 2147483648` would pass DTO validation, then crash the
 * `prisma.video.create` write with an out-of-range error instead of the
 * clean `400` the DTO is supposed to produce — turning a validation
 * boundary into a 500. `MAX_UPLOAD_BYTES` is therefore the largest value
 * that is BOTH "about 2 GiB" AND safe to persist into that column: `2^31 -
 * 1`, one byte under the round number, matching Postgres `integer`'s actual
 * max. A single presigned `PUT` this size is already impractical in
 * practice (see `phases/phase-11-slice-11L-PLAN.md` §13 — multipart upload
 * is explicitly out of scope for this slice), so the one-byte difference
 * from a literal 2 GiB has no real-world effect.
 */
export const MAX_UPLOAD_BYTES = 2_147_483_647;
