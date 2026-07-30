import { PrismaService } from '../prisma/prisma.service';
import {
  RetentionResidueModelDetail,
  RetentionTargetReport,
} from './retention.types';

/**
 * Phase 12, work unit 12D-B1: "deleted-account residue" — extracted out of
 * `retention.service.ts` into its own file purely for file-size/cohesion
 * (the 8-model enumeration below is long but each line is simple); the
 * design/safety reasoning lives here, not duplicated elsewhere.
 *
 * A genuine ORPHAN row is one with a non-null `userId` that does not resolve
 * to any existing `User` row. Deliberately NOT "any row with `userId IS
 * NULL`" — `AnalyticsEvent`/`AuthAuditEvent` rows with a null `userId` are
 * the intended, anonymized record of a deleted account, not residue, and the
 * queries below EXCLUDE them by construction (every check either only looks
 * at models where `userId` is a required column in the first place, or, for
 * the two nullable-`userId` models, explicitly filters to
 * `userId: { not: null }` before ever considering a row a candidate). The
 * two models get there by different mechanisms, not one shared one:
 * `AnalyticsEvent` is anonymized by `onDelete: SetNull` alone (decision 2 —
 * it has no `ipHash`/`userAgent` column, so nulling `userId` is sufficient);
 * `AuthAuditEvent` additionally needs, and gets, an explicit pre-delete scrub
 * of `ipHash`/`userAgent`/`metadata` (decision 1, `DECISIONS.md`
 * 2026-07-30, work unit 12E-B1) — `SetNull` alone would leave its globally
 * stable, unsalted `ipHash` behind, which decision 1 is explicit must never
 * be described as anonymizing the row.
 *
 * Given every one of the 8 `User`-relation models in `prisma/schema.prisma`
 * (`Session`, `UserVideoInteraction`, `WatchProgress`, `Entitlement`,
 * `PasswordResetToken`, `AccountLockout` — all `onDelete: Cascade` —, plus
 * `AnalyticsEvent`/`AuthAuditEvent` — both `onDelete: SetNull`) carries a
 * REAL Postgres foreign-key CONSTRAINT (not merely a Prisma-level relation),
 * a row referencing a `userId` that does not exist cannot be INSERTED in the
 * first place — the FK constraint rejects it regardless of whether the
 * write goes through Prisma's typed client or raw SQL, and it is enforced
 * independently of the column's `onDelete` action (`Cascade` and `SetNull`
 * only govern what happens to an EXISTING row when its REFERENCED `User` is
 * later deleted, not whether a dangling reference can be created in the
 * first place). So under this schema's current constraints, a genuine
 * orphan is expected to be IMPOSSIBLE, and this function's normal, correct
 * outcome is `matchedCount: 0` for every one of the 8 models, always (see
 * `retention.integration.spec.ts`'s dedicated proof that Postgres itself
 * rejects an attempt to insert one).
 *
 * This is still implemented as a real (not merely asserted) scan — not a
 * hardcoded zero — so it keeps working as a DEFENSIVE drift-detector if a
 * future migration ever weakens or drops one of these FK constraints, or a
 * bulk/administrative script ever bypasses Prisma and the database
 * constraint entirely (e.g. a restored backup, a manual `COPY`). It
 * deliberately does NOT use raw SQL to build this scan — this work unit's
 * own instructions warn against creating a sixth raw-SQL call site in a repo
 * where the fifth (`changePassword`) was the one 12D-B0 just spent an entire
 * work unit fixing — instead it fetches each model's `userId` values via
 * Prisma's typed client, then diffs the distinct id list against `User` in
 * one batched `findMany` per model (mirroring 12C-B2's "one batched query,
 * not N+1" precedent), entirely in application code.
 */
export async function processDeletedAccountResidue(
  prisma: PrismaService,
  commit: boolean,
): Promise<RetentionTargetReport> {
  const residueDetails: RetentionResidueModelDetail[] = [
    await checkRequiredUserIdModel(
      prisma,
      'session',
      commit,
      () => prisma.session.findMany({ select: { userId: true } }),
      (orphanIds) =>
        prisma.session.deleteMany({ where: { userId: { in: orphanIds } } }),
    ),
    await checkRequiredUserIdModel(
      prisma,
      'userVideoInteraction',
      commit,
      () => prisma.userVideoInteraction.findMany({ select: { userId: true } }),
      (orphanIds) =>
        prisma.userVideoInteraction.deleteMany({
          where: { userId: { in: orphanIds } },
        }),
    ),
    await checkRequiredUserIdModel(
      prisma,
      'watchProgress',
      commit,
      () => prisma.watchProgress.findMany({ select: { userId: true } }),
      (orphanIds) =>
        prisma.watchProgress.deleteMany({
          where: { userId: { in: orphanIds } },
        }),
    ),
    await checkRequiredUserIdModel(
      prisma,
      'entitlement',
      commit,
      () => prisma.entitlement.findMany({ select: { userId: true } }),
      (orphanIds) =>
        prisma.entitlement.deleteMany({
          where: { userId: { in: orphanIds } },
        }),
    ),
    await checkRequiredUserIdModel(
      prisma,
      'passwordResetToken',
      commit,
      () => prisma.passwordResetToken.findMany({ select: { userId: true } }),
      (orphanIds) =>
        prisma.passwordResetToken.deleteMany({
          where: { userId: { in: orphanIds } },
        }),
    ),
    await checkRequiredUserIdModel(
      prisma,
      'accountLockout',
      commit,
      () => prisma.accountLockout.findMany({ select: { userId: true } }),
      (orphanIds) =>
        prisma.accountLockout.deleteMany({
          where: { userId: { in: orphanIds } },
        }),
    ),
    // The two `onDelete: SetNull` models: `findRows` filters to
    // `userId: { not: null }` explicitly, so an anonymized row
    // (`userId: null` — decision 2 for `AnalyticsEvent`, decision 1 plus the
    // 12E-B1 scrub for `AuthAuditEvent`, see this file's header comment) is
    // never fetched as a candidate at all, let alone flagged as an orphan or
    // deleted.
    await checkOptionalUserIdModel(
      prisma,
      'analyticsEvent',
      commit,
      () =>
        prisma.analyticsEvent.findMany({
          where: { userId: { not: null } },
          select: { userId: true },
        }),
      (orphanIds) =>
        prisma.analyticsEvent.deleteMany({
          where: { userId: { in: orphanIds } },
        }),
    ),
    await checkOptionalUserIdModel(
      prisma,
      'authAuditEvent',
      commit,
      () =>
        prisma.authAuditEvent.findMany({
          where: { userId: { not: null } },
          select: { userId: true },
        }),
      (orphanIds) =>
        prisma.authAuditEvent.deleteMany({
          where: { userId: { in: orphanIds } },
        }),
    ),
  ];

  const matchedCount = residueDetails.reduce(
    (sum, detail) => sum + detail.matchedCount,
    0,
  );
  const deletedCount = residueDetails.reduce(
    (sum, detail) => sum + detail.deletedCount,
    0,
  );

  return {
    target: 'deletedAccountResidue',
    cutoff: null,
    matchedCount,
    deletedCount,
    residueDetails,
  };
}

/**
 * Required-`userId` models (`Session`, `UserVideoInteraction`,
 * `WatchProgress`, `Entitlement`, `PasswordResetToken`, `AccountLockout`):
 * every row already has a non-null `userId` by schema definition, so no
 * extra filter is needed to exclude anonymized rows — there is no such
 * thing as an anonymized row in these tables (they cascade-delete entirely
 * instead, per their own schema doc comments).
 */
async function checkRequiredUserIdModel(
  prisma: PrismaService,
  model: string,
  commit: boolean,
  findRows: () => Promise<{ userId: string }[]>,
  deleteOrphans: (orphanIds: string[]) => Promise<{ count: number }>,
): Promise<RetentionResidueModelDetail> {
  const rows = await findRows();
  const orphanIds = await findOrphanUserIds(
    prisma,
    rows.map((row) => row.userId),
  );
  const deletedCount =
    commit && orphanIds.length > 0 ? (await deleteOrphans(orphanIds)).count : 0;

  return { model, matchedCount: orphanIds.length, deletedCount };
}

/**
 * Optional-`userId` models (`AnalyticsEvent`, `AuthAuditEvent`): the
 * caller-supplied `findRows` MUST already filter to `userId: { not: null }`
 * (see the two call sites above) — this is what guarantees an anonymized row
 * (`userId: null` — see this file's header comment for the two different
 * mechanisms that get each model there) can never even be fetched as a
 * candidate here, let alone flagged as an "orphan" or deleted.
 */
async function checkOptionalUserIdModel(
  prisma: PrismaService,
  model: string,
  commit: boolean,
  findRows: () => Promise<{ userId: string | null }[]>,
  deleteOrphans: (orphanIds: string[]) => Promise<{ count: number }>,
): Promise<RetentionResidueModelDetail> {
  const rows = await findRows();
  const orphanIds = await findOrphanUserIds(
    prisma,
    rows.map((row) => row.userId),
  );
  const deletedCount =
    commit && orphanIds.length > 0 ? (await deleteOrphans(orphanIds)).count : 0;

  return { model, matchedCount: orphanIds.length, deletedCount };
}

/**
 * Given a list of `userId` values already fetched from a single model
 * (possibly with duplicates — no `distinct` is requested at the query
 * level, deliberately, to keep each model's `findRows` callback a plain,
 * obviously-correct `findMany`; de-duplication happens here instead),
 * returns the subset that do NOT resolve to an existing `User` row, via one
 * batched `User.findMany` rather than one query per candidate id.
 */
async function findOrphanUserIds(
  prisma: PrismaService,
  userIds: (string | null)[],
): Promise<string[]> {
  const distinctIds = Array.from(
    new Set(userIds.filter((id): id is string => id !== null)),
  );

  if (distinctIds.length === 0) {
    return [];
  }

  const existingUsers = await prisma.user.findMany({
    where: { id: { in: distinctIds } },
    select: { id: true },
  });
  const existingIds = new Set(existingUsers.map((user) => user.id));

  return distinctIds.filter((id) => !existingIds.has(id));
}
