-- AlterTable
ALTER TABLE "Video" ADD COLUMN     "processingState" TEXT,
ADD COLUMN     "processingVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Video_processingState_idx" ON "Video"("processingState");
