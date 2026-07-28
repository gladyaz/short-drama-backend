-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "ipHash" TEXT,
ADD COLUMN     "lastUsedAt" TIMESTAMP(3),
ADD COLUMN     "userAgent" TEXT;
