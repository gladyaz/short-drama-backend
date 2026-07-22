-- CreateTable
CREATE TABLE "Video" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "seriesId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "episodeNumber" INTEGER NOT NULL,
    "channelName" TEXT NOT NULL,
    "caption" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sourceLanguage" TEXT NOT NULL,
    "hasEmbeddedIndonesianSubtitle" BOOLEAN NOT NULL,
    "likeCount" INTEGER NOT NULL,
    "durationSeconds" INTEGER,
    "width" INTEGER,
    "height" INTEGER
);

-- CreateIndex
CREATE INDEX "Video_seriesId_idx" ON "Video"("seriesId");
