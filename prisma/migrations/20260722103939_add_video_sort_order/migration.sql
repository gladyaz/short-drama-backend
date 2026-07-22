-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Video" (
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
    "height" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0
);
INSERT INTO "new_Video" ("caption", "category", "channelName", "durationSeconds", "episodeNumber", "hasEmbeddedIndonesianSubtitle", "height", "id", "likeCount", "seriesId", "sourceLanguage", "storageKey", "title", "width") SELECT "caption", "category", "channelName", "durationSeconds", "episodeNumber", "hasEmbeddedIndonesianSubtitle", "height", "id", "likeCount", "seriesId", "sourceLanguage", "storageKey", "title", "width" FROM "Video";
DROP TABLE "Video";
ALTER TABLE "new_Video" RENAME TO "Video";
CREATE INDEX "Video_seriesId_idx" ON "Video"("seriesId");
CREATE INDEX "Video_sortOrder_idx" ON "Video"("sortOrder");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- Backfill sortOrder for the 40 pre-existing rows to reproduce the original
-- curated feed order from `src/videos/videos.data.ts` (series-104 first,
-- then series-010, series-101, series-105 — each in episode order). New
-- rows created after this migration (e.g. by `prisma/seed.ts`, which does
-- not set this column) will keep the `0` default and simply sort first;
-- widening the seed script to assign sortOrder explicitly is out of scope
-- for this fix.
UPDATE "Video" SET "sortOrder" = 0 WHERE "id" = 'video-104-01';
UPDATE "Video" SET "sortOrder" = 1 WHERE "id" = 'video-104-02';
UPDATE "Video" SET "sortOrder" = 2 WHERE "id" = 'video-104-03';
UPDATE "Video" SET "sortOrder" = 3 WHERE "id" = 'video-104-04';
UPDATE "Video" SET "sortOrder" = 4 WHERE "id" = 'video-104-05';
UPDATE "Video" SET "sortOrder" = 5 WHERE "id" = 'video-104-06';
UPDATE "Video" SET "sortOrder" = 6 WHERE "id" = 'video-104-07';
UPDATE "Video" SET "sortOrder" = 7 WHERE "id" = 'video-104-08';
UPDATE "Video" SET "sortOrder" = 8 WHERE "id" = 'video-104-09';
UPDATE "Video" SET "sortOrder" = 9 WHERE "id" = 'video-104-10';
UPDATE "Video" SET "sortOrder" = 10 WHERE "id" = 'video-010-01';
UPDATE "Video" SET "sortOrder" = 11 WHERE "id" = 'video-010-02';
UPDATE "Video" SET "sortOrder" = 12 WHERE "id" = 'video-010-03';
UPDATE "Video" SET "sortOrder" = 13 WHERE "id" = 'video-010-04';
UPDATE "Video" SET "sortOrder" = 14 WHERE "id" = 'video-010-05';
UPDATE "Video" SET "sortOrder" = 15 WHERE "id" = 'video-010-06';
UPDATE "Video" SET "sortOrder" = 16 WHERE "id" = 'video-010-07';
UPDATE "Video" SET "sortOrder" = 17 WHERE "id" = 'video-010-08';
UPDATE "Video" SET "sortOrder" = 18 WHERE "id" = 'video-010-09';
UPDATE "Video" SET "sortOrder" = 19 WHERE "id" = 'video-010-10';
UPDATE "Video" SET "sortOrder" = 20 WHERE "id" = 'video-101-01';
UPDATE "Video" SET "sortOrder" = 21 WHERE "id" = 'video-101-02';
UPDATE "Video" SET "sortOrder" = 22 WHERE "id" = 'video-101-03';
UPDATE "Video" SET "sortOrder" = 23 WHERE "id" = 'video-101-04';
UPDATE "Video" SET "sortOrder" = 24 WHERE "id" = 'video-101-05';
UPDATE "Video" SET "sortOrder" = 25 WHERE "id" = 'video-101-06';
UPDATE "Video" SET "sortOrder" = 26 WHERE "id" = 'video-101-07';
UPDATE "Video" SET "sortOrder" = 27 WHERE "id" = 'video-101-08';
UPDATE "Video" SET "sortOrder" = 28 WHERE "id" = 'video-101-09';
UPDATE "Video" SET "sortOrder" = 29 WHERE "id" = 'video-101-10';
UPDATE "Video" SET "sortOrder" = 30 WHERE "id" = 'video-105-01';
UPDATE "Video" SET "sortOrder" = 31 WHERE "id" = 'video-105-02';
UPDATE "Video" SET "sortOrder" = 32 WHERE "id" = 'video-105-03';
UPDATE "Video" SET "sortOrder" = 33 WHERE "id" = 'video-105-04';
UPDATE "Video" SET "sortOrder" = 34 WHERE "id" = 'video-105-05';
UPDATE "Video" SET "sortOrder" = 35 WHERE "id" = 'video-105-06';
UPDATE "Video" SET "sortOrder" = 36 WHERE "id" = 'video-105-07';
UPDATE "Video" SET "sortOrder" = 37 WHERE "id" = 'video-105-08';
UPDATE "Video" SET "sortOrder" = 38 WHERE "id" = 'video-105-09';
UPDATE "Video" SET "sortOrder" = 39 WHERE "id" = 'video-105-10';
