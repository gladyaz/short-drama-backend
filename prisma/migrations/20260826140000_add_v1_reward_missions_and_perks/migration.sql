-- Work unit "REWARDS V1 EARN AND SPEND".
--
-- Closes the V1 loop the "REWARDS BACKEND FOUNDATION" migration deliberately
-- left open: ACTIVITY -> EARN -> SPEND -> a real perk.
--
--   RewardMissionClaim  one row per (user, mission, reward day) — the social
--                       follow missions and the daily watch milestones.
--   RewardWatchCredit   server-observed evidence that this backend authorised
--                       playback of one episode for one user on one reward day.
--   RewardPerk          what points buy: an ad-skip or a temporary ad pass.
--   RewardRedemption.perkId  links a redemption to the perk it issued, the way
--                       entitlementId already links one to the premium it bought.
--
-- ADDITIVE ONLY. No column is dropped, no data is rewritten, and every new
-- column is nullable or defaulted, so this migration is safe to apply to a
-- populated database and safe to roll forward onto an already-running V1.

-- AlterTable
ALTER TABLE "RewardRedemption" ADD COLUMN     "perkId" TEXT;

-- CreateTable
CREATE TABLE "RewardMissionClaim" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "missionType" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "destinationUrl" TEXT,
    "openedAt" TIMESTAMP(3),
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMP(3),
    "awardedPoints" INTEGER,
    "ledgerEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RewardMissionClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardWatchCredit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "seriesId" TEXT,
    "episodeNumber" INTEGER,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RewardWatchCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardPerk" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "perkType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "remainingUses" INTEGER,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RewardPerk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RewardMissionClaim_ledgerEntryId_key" ON "RewardMissionClaim"("ledgerEntryId");

-- CreateIndex
CREATE INDEX "RewardMissionClaim_userId_claimedAt_idx" ON "RewardMissionClaim"("userId", "claimedAt");

-- CreateIndex
CREATE INDEX "RewardMissionClaim_missionId_idx" ON "RewardMissionClaim"("missionId");

-- CreateIndex
CREATE UNIQUE INDEX "RewardMissionClaim_userId_missionId_periodKey_key" ON "RewardMissionClaim"("userId", "missionId", "periodKey");

-- CreateIndex
CREATE INDEX "RewardWatchCredit_userId_periodKey_idx" ON "RewardWatchCredit"("userId", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "RewardWatchCredit_userId_periodKey_videoId_key" ON "RewardWatchCredit"("userId", "periodKey", "videoId");

-- CreateIndex
CREATE INDEX "RewardPerk_userId_status_idx" ON "RewardPerk"("userId", "status");

-- CreateIndex
CREATE INDEX "RewardPerk_expiresAt_idx" ON "RewardPerk"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "RewardRedemption_perkId_key" ON "RewardRedemption"("perkId");

-- AddForeignKey
ALTER TABLE "RewardMissionClaim" ADD CONSTRAINT "RewardMissionClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardWatchCredit" ADD CONSTRAINT "RewardWatchCredit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardPerk" ADD CONSTRAINT "RewardPerk_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- CHECK constraints. Prisma has no schema syntax for them, so — exactly as in
-- the foundation migration — they live here. They are LAST-RESORT backstops,
-- never the primary control: application code refuses each of these conditions
-- with a clean error first. They exist so that a future writer that forgets is
-- refused by the database rather than silently corrupting the economy.
-- ---------------------------------------------------------------------------

-- RELAXED, not added. The foundation migration required `grantsDays > 0`
-- because every offer in the catalog bought premium days. V1 adds AD_PERK
-- offers, which buy an ad perk and no premium at all, and record `0` days.
-- The invariant that still holds — and is what the constraint was really
-- protecting — is that a receipt never claims a NEGATIVE benefit.
ALTER TABLE "RewardRedemption"
  DROP CONSTRAINT IF EXISTS "RewardRedemption_grantsDays_positive";

ALTER TABLE "RewardRedemption"
  ADD CONSTRAINT "RewardRedemption_grantsDays_nonnegative"
  CHECK ("grantsDays" >= 0);

-- A mission that has been claimed was worth something. `NULL` is the
-- unclaimed state; `0` would be a claim that paid nothing, which is a bug
-- wearing a claim's clothes.
ALTER TABLE "RewardMissionClaim"
  ADD CONSTRAINT "RewardMissionClaim_awardedPoints_positive"
  CHECK ("awardedPoints" IS NULL OR "awardedPoints" > 0);

ALTER TABLE "RewardMissionClaim"
  ADD CONSTRAINT "RewardMissionClaim_openCount_nonnegative"
  CHECK ("openCount" >= 0);

-- `NULL` means "not a use-counted perk" (a duration pass). `0` means a
-- single-use perk that has been spent. Negative means someone spent it twice,
-- which is the condition the consume path's conditional UPDATE exists to make
-- impossible.
ALTER TABLE "RewardPerk"
  ADD CONSTRAINT "RewardPerk_remainingUses_nonnegative"
  CHECK ("remainingUses" IS NULL OR "remainingUses" >= 0);
