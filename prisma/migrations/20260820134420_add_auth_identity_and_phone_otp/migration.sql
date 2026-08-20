-- PHASE 10B — PRODUCTION IDENTITY PROVIDERS.
--
-- SAFETY PROPERTIES OF THIS MIGRATION (reviewed before writing, not after):
--
--   1. `DROP NOT NULL` on `User.email` / `User.passwordHash` is a catalog-only
--      change in PostgreSQL — it rewrites no rows and reads no data, so every
--      existing account keeps its exact current email and password hash. It is
--      also the only ordering that works: the backfill below reads those very
--      columns, and the `AuthIdentity` table it writes into must exist first.
--
--   2. The two `CREATE TABLE`s are purely additive. No existing table is
--      dropped, renamed, or has a column removed, so a running instance of the
--      PREVIOUS build keeps working unchanged against this schema (the new
--      tables are simply never read by it) — this migration is safe to apply
--      before the new code is deployed.
--
--   3. The backfill STATEMENT at the bottom is idempotent (`ON CONFLICT DO
--      NOTHING` against the same unique constraints the running application
--      relies on): re-executing it can never create a duplicate identity or
--      raise a constraint error, and it correctly picks up accounts created
--      since the last run. (That is a property of the INSERT itself, not a
--      claim that this whole file can be replayed — the `CREATE TABLE`s
--      above are not `IF NOT EXISTS`, and Prisma never re-runs an applied
--      migration. It matters because the backfill's coverage is what the
--      verification block below asserts, and because an operator
--      investigating a partial deploy can safely re-execute the INSERT by
--      hand.)
--
-- VERIFIED, not assumed: all three properties above were exercised against a
-- throwaway PostgreSQL 16 database seeded with pre-existing accounts —
-- including a positive control proving the verification block at the bottom
-- genuinely FAILS the migration on a duplicate-cased email rather than
-- passing silently.
--
-- NOT APPLIED TO PRODUCTION BY THIS WORK UNIT. It has been applied only to
-- the local `short_drama_dev` database (via `prisma migrate deploy`), the
-- local `short_drama_test` database (via `prisma db push`), and a throwaway
-- verification database that has since been dropped.

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL,
ALTER COLUMN "passwordHash" DROP NOT NULL;

-- CreateTable
CREATE TABLE "AuthIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerSubject" TEXT NOT NULL,
    "normalizedIdentifier" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),

    CONSTRAINT "AuthIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhoneOtpChallenge" (
    "id" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    -- Fix cycle 1 (Reviewer B, finding 1): equal to "phoneE164" while the
    -- challenge is live, NULL once consumed. The plain nullable UNIQUE index
    -- below is what makes "at most one live challenge per number" a database
    -- invariant instead of an application-level reconciliation that two
    -- concurrent callers could each win — see this column's doc comment in
    -- prisma/schema.prisma. Same mechanism as "PaymentOrder"."openOrderKey".
    "liveKey" TEXT,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipHash" TEXT,

    CONSTRAINT "PhoneOtpChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuthIdentity_userId_idx" ON "AuthIdentity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthIdentity_provider_providerSubject_key" ON "AuthIdentity"("provider", "providerSubject");

-- CreateIndex
CREATE UNIQUE INDEX "AuthIdentity_userId_provider_key" ON "AuthIdentity"("userId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneOtpChallenge_liveKey_key" ON "PhoneOtpChallenge"("liveKey");

-- CreateIndex
CREATE INDEX "PhoneOtpChallenge_phoneE164_createdAt_idx" ON "PhoneOtpChallenge"("phoneE164", "createdAt");

-- CreateIndex
CREATE INDEX "PhoneOtpChallenge_expiresAt_idx" ON "PhoneOtpChallenge"("expiresAt");

-- AddForeignKey
ALTER TABLE "AuthIdentity" ADD CONSTRAINT "AuthIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- PHASE 10B BACKFILL — give every PRE-EXISTING account an explicit `email`
-- AuthIdentity row.
--
-- WHY THIS IS REQUIRED, not cosmetic: from this migration onward,
-- `AuthIdentity` is the authoritative answer to "which methods can this
-- account sign in with." `GET /auth/identities` lists it, and — critically —
-- `DELETE /auth/identities/:provider` refuses to remove an account's LAST
-- usable authentication method by counting these rows. Without this
-- backfill, an existing email/password user who later links Google would
-- have exactly one identity row (`google`), and unlinking it would be
-- permitted — silently stranding an account that still has a perfectly good
-- password. The rows below are what make that check correct for accounts
-- created before the table existed.
--
-- `providerSubject` and `normalizedIdentifier` are `lower(email)` because
-- that is precisely what `AuthService.register`/`.login` have always
-- normalized to before touching the database (`dto.email.toLowerCase()`), so
-- these rows agree with the application byte-for-byte.
--
-- `verifiedAt` is deliberately left NULL. This application has never
-- implemented email-address verification, so stamping a verification
-- timestamp here would fabricate an ownership proof that never happened —
-- and `verifiedAt` is evidence an operator may later read, not a value to
-- fill in for tidiness.
--
-- `WHERE "email" IS NOT NULL` is defensive only: no row can have a NULL
-- email at this point in the migration (the column was NOT NULL until three
-- statements ago). It costs nothing and keeps the statement correct if this
-- file is ever replayed against a database that already has newer,
-- email-less accounts.
--
-- `gen_random_uuid()` is a PostgreSQL 13+ builtin (this project targets
-- PostgreSQL 16 — see `docker-compose.yml`), used because `cuid()` is
-- generated by the Prisma client in application code and has no SQL
-- equivalent. `AuthIdentity.id` is an opaque surrogate key that nothing
-- parses or pattern-matches, so the two id formats coexisting in one column
-- is harmless; the `ai_` prefix simply makes a backfilled row obvious to an
-- operator reading the table.
INSERT INTO "AuthIdentity" ("id", "userId", "provider", "providerSubject", "normalizedIdentifier", "createdAt", "verifiedAt")
SELECT
    'ai_' || replace(gen_random_uuid()::text, '-', ''),
    "id",
    'email',
    lower("email"),
    lower("email"),
    "createdAt",
    NULL
FROM "User"
WHERE "email" IS NOT NULL
ON CONFLICT DO NOTHING;

-- PHASE 10B BACKFILL VERIFICATION — fail the migration LOUDLY if the insert
-- above did not cover every account.
--
-- `ON CONFLICT DO NOTHING` buys idempotency at the cost of silence, and
-- there is one real (if unlikely) way it could under-backfill: `User.email`
-- is a CASE-SENSITIVE unique column, so nothing at the database level has
-- ever prevented two accounts holding "Foo@example.com" and
-- "foo@example.com". `AuthService.register`/`.login` have always lowercased
-- before touching the database, so no such pair can exist from normal use —
-- but a seed script or a manual insert could have created one, and both rows
-- would collapse to the SAME `lower(email)` here. One would win the unique
-- index and the other would be skipped, leaving a real account with zero
-- authentication methods on record and a `DELETE /auth/identities/:provider`
-- last-method check that under-counts for it.
--
-- Rather than let that pass quietly, this block aborts the migration and
-- names the exact number of affected accounts. Recovery is a deliberate
-- human decision (merge or rename the duplicate-cased accounts, then re-run)
-- — deliberately not automated here, because choosing which of two real
-- accounts keeps an email address is not a migration's call to make. No
-- email address is included in the message; only a count.
DO $$
DECLARE
    unbackfilled_count integer;
BEGIN
    SELECT count(*) INTO unbackfilled_count
    FROM "User" u
    WHERE u."email" IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM "AuthIdentity" ai
          WHERE ai."userId" = u."id" AND ai."provider" = 'email'
      );

    IF unbackfilled_count > 0 THEN
        RAISE EXCEPTION
            'PHASE 10B backfill incomplete: % account(s) with an email have no email AuthIdentity row. The most likely cause is two accounts whose emails differ only by letter case, which collapse to the same lower(email) identity subject. Resolve those accounts manually, then re-run this migration.',
            unbackfilled_count;
    END IF;
END $$;
