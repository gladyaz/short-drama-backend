-- CreateTable
CREATE TABLE "UserVideoInteraction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "isLiked" BOOLEAN NOT NULL DEFAULT false,
    "isSaved" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserVideoInteraction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WatchProgress" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "lastWatchedVideoId" TEXT NOT NULL,
    "lastWatchedEpisodeNumber" INTEGER NOT NULL,
    "positionSeconds" INTEGER NOT NULL,
    "durationSeconds" INTEGER,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WatchProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "UserVideoInteraction_userId_idx" ON "UserVideoInteraction"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserVideoInteraction_userId_videoId_key" ON "UserVideoInteraction"("userId", "videoId");

-- CreateIndex
CREATE INDEX "WatchProgress_userId_idx" ON "WatchProgress"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WatchProgress_userId_seriesId_key" ON "WatchProgress"("userId", "seriesId");
