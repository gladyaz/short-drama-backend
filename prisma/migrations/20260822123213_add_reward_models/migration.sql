-- CreateTable
CREATE TABLE "RewardWallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "balancePoints" INTEGER NOT NULL DEFAULT 0,
    "lifetimeEarnedPoints" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RewardWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardLedgerEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "deltaPoints" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RewardLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardCheckIn" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currentStreakDays" INTEGER NOT NULL DEFAULT 0,
    "longestStreakDays" INTEGER NOT NULL DEFAULT 0,
    "totalCheckInDays" INTEGER NOT NULL DEFAULT 0,
    "lastCheckInDate" TEXT,
    "lastCheckInAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RewardCheckIn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardRedemption" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "costPoints" INTEGER NOT NULL,
    "grantsDays" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "ledgerEntryId" TEXT,
    "entitlementId" TEXT,
    "entitlementExpiresAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RewardRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RewardWallet_userId_key" ON "RewardWallet"("userId");

-- CreateIndex
CREATE INDEX "RewardWallet_userId_idx" ON "RewardWallet"("userId");

-- CreateIndex
CREATE INDEX "RewardLedgerEntry_userId_createdAt_idx" ON "RewardLedgerEntry"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "RewardLedgerEntry_walletId_idx" ON "RewardLedgerEntry"("walletId");

-- CreateIndex
CREATE INDEX "RewardLedgerEntry_reason_idx" ON "RewardLedgerEntry"("reason");

-- CreateIndex
CREATE UNIQUE INDEX "RewardLedgerEntry_userId_idempotencyKey_key" ON "RewardLedgerEntry"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "RewardCheckIn_userId_key" ON "RewardCheckIn"("userId");

-- CreateIndex
CREATE INDEX "RewardCheckIn_userId_idx" ON "RewardCheckIn"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RewardRedemption_ledgerEntryId_key" ON "RewardRedemption"("ledgerEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "RewardRedemption_entitlementId_key" ON "RewardRedemption"("entitlementId");

-- CreateIndex
CREATE INDEX "RewardRedemption_userId_createdAt_idx" ON "RewardRedemption"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "RewardRedemption_status_idx" ON "RewardRedemption"("status");

-- CreateIndex
CREATE UNIQUE INDEX "RewardRedemption_userId_idempotencyKey_key" ON "RewardRedemption"("userId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "RewardWallet" ADD CONSTRAINT "RewardWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardLedgerEntry" ADD CONSTRAINT "RewardLedgerEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardLedgerEntry" ADD CONSTRAINT "RewardLedgerEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "RewardWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardCheckIn" ADD CONSTRAINT "RewardCheckIn_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardRedemption" ADD CONSTRAINT "RewardRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Integrity backstops that Prisma's schema language cannot express.
--
-- These are NOT the primary control. `RewardsWalletService.appendEntry`
-- refuses an overdrawing debit in application code and returns a clean
-- `INSUFFICIENT_REWARD_POINTS` error, and it never constructs a zero delta.
-- These constraints exist so that a FUTURE writer that forgets those rules
-- is refused by the database instead of silently minting points or a
-- negative balance. A rewards system whose only guard against a free-money
-- bug is "every caller remembers to check" is one careless commit away from
-- being a faucet.
-- ---------------------------------------------------------------------------

-- A balance is a projection of a sum of credits and debits; it can reach zero
-- but must never go below it.
ALTER TABLE "RewardWallet"
  ADD CONSTRAINT "RewardWallet_balancePoints_nonnegative"
  CHECK ("balancePoints" >= 0);

-- Lifetime earned counts credits only, so it is monotonic by construction.
ALTER TABLE "RewardWallet"
  ADD CONSTRAINT "RewardWallet_lifetimeEarnedPoints_nonnegative"
  CHECK ("lifetimeEarnedPoints" >= 0);

-- A zero-delta ledger row is an audit record of nothing happening. That
-- belongs in a log, not in a ledger, and admitting one would let a caller
-- consume an idempotency key without moving any points.
ALTER TABLE "RewardLedgerEntry"
  ADD CONSTRAINT "RewardLedgerEntry_deltaPoints_nonzero"
  CHECK ("deltaPoints" <> 0);

-- `balanceAfter` snapshots the projection immediately after the entry, so it
-- is subject to the same floor as the projection itself.
ALTER TABLE "RewardLedgerEntry"
  ADD CONSTRAINT "RewardLedgerEntry_balanceAfter_nonnegative"
  CHECK ("balanceAfter" >= 0);

-- A redemption always costs something and always grants a positive span.
ALTER TABLE "RewardRedemption"
  ADD CONSTRAINT "RewardRedemption_costPoints_positive"
  CHECK ("costPoints" > 0);

ALTER TABLE "RewardRedemption"
  ADD CONSTRAINT "RewardRedemption_grantsDays_positive"
  CHECK ("grantsDays" > 0);
