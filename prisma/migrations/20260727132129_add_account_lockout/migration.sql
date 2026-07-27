-- CreateTable
CREATE TABLE "AccountLockout" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "windowStartedAt" TIMESTAMP(3),
    "lockedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountLockout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountLockout_userId_key" ON "AccountLockout"("userId");

-- CreateIndex
CREATE INDEX "AccountLockout_lockedUntil_idx" ON "AccountLockout"("lockedUntil");

-- AddForeignKey
ALTER TABLE "AccountLockout" ADD CONSTRAINT "AccountLockout_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
