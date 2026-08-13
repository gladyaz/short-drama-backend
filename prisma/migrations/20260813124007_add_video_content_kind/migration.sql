-- AlterTable
-- Additive and defaulted, so all 42 pre-existing rows are backfilled to the
-- normal catalog value in a single statement and no caller that creates a
-- Video without this column has to change. Same backfill-safety pattern as
-- the `lifecycleState` / `sortOrder` columns.
ALTER TABLE "Video" ADD COLUMN     "contentKind" TEXT NOT NULL DEFAULT 'drama';

-- QA-DATA RECONCILIATION (not runtime classification).
--
-- These two rows are internal technical fixtures that were created through
-- the admin media pipeline and have always lived in the catalog alongside
-- real content:
--
--   media-11rqa-8ac6a7f3                        "11R QA HLS Sample"
--     seriesId series-11rqa, processingState 'ready', hlsMasterKey set.
--     KEPT AND STILL SERVED - it is the sample used for internal HLS
--     playback testing. Reclassifying it does not unpublish, hide or delete
--     it; `VideosService#findAll` still returns it.
--
--   media-54d5a084-bd85-4939-ba60-ab6534916a48  "test-disposable"
--     seriesId 7, a disposable admin-upload test row.
--
-- Scoped to these two literal primary keys ON PURPOSE. This is a one-time
-- correction of two known fixtures' data, NOT a rule: nothing here infers a
-- classification from title, channelName, sourceLanguage, storageKey,
-- dimensions or seriesId shape, and no equivalent predicate exists anywhere
-- in application code. Any future fixture must declare `contentKind`
-- explicitly at creation time instead of relying on a pattern.
--
-- Idempotent and safe on a database where these ids are absent (e.g. a fresh
-- test database seeded only with the 40 catalog rows): the statement simply
-- matches zero rows.
UPDATE "Video"
SET "contentKind" = 'qa_fixture'
WHERE "id" IN (
  'media-11rqa-8ac6a7f3',
  'media-54d5a084-bd85-4939-ba60-ab6534916a48'
);
