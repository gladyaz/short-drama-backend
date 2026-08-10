-- AlterTable
ALTER TABLE "Video" ADD COLUMN     "hlsMasterKey" TEXT,
ADD COLUMN     "hlsRenditions" JSONB,
ADD COLUMN     "processingAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "processingCompletedAt" TIMESTAMP(3),
ADD COLUMN     "processingErrorCode" TEXT,
ADD COLUMN     "processingErrorMessage" TEXT,
ADD COLUMN     "processingStartedAt" TIMESTAMP(3),
ADD COLUMN     "processingStep" TEXT,
ADD COLUMN     "sourceDurationSeconds" INTEGER,
ADD COLUMN     "sourceFps" DOUBLE PRECISION,
ADD COLUMN     "sourceHeight" INTEGER,
ADD COLUMN     "sourceWidth" INTEGER,
ADD COLUMN     "transcodeProfileVersion" TEXT;
