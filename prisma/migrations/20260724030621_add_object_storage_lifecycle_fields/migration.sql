-- AlterTable
ALTER TABLE "Video" ADD COLUMN     "coverImageKey" TEXT,
ADD COLUMN     "lifecycleState" TEXT NOT NULL DEFAULT 'published',
ADD COLUMN     "objectStorageKey" TEXT,
ADD COLUMN     "objectStorageVariant" TEXT,
ADD COLUMN     "thumbnailImageKey" TEXT;

-- CreateIndex
CREATE INDEX "Video_lifecycleState_idx" ON "Video"("lifecycleState");
