-- V1 PROVIDER ACCOUNT DELETION — give every `PhoneOtpChallenge` an explicit
-- purpose, so a WhatsApp-only account can re-prove control of its number
-- before an irreversible delete WITHOUT a second, parallel OTP system.
--
-- Two statements, both backward-safe on a live database:
--
--   1. ADD COLUMN with a DEFAULT. Postgres 11+ records the default in the
--      catalog instead of rewriting the table, so this is a metadata-only
--      change even on a large table. Every pre-existing row therefore reads
--      back as `login`, which is exactly what it was: `login` was the only
--      purpose this table had before now.
--
--   2. BACKFILL `liveKey`. `WhatsAppOtpService` now claims the live slot as
--      `"<purpose>:<phoneE164>"` rather than the bare number (see the
--      `liveKey` doc comment in `prisma/schema.prisma` for why the slot has
--      to be per-purpose). Rewriting the outstanding live rows into the new
--      namespace is what stops a challenge issued moments before this
--      migration from holding a slot no new request will ever collide with —
--      which would let a number briefly hold two live LOGIN challenges.
--      Scoped to `liveKey IS NOT NULL`, so consumed/retired rows (which
--      deliberately carry `NULL` and must keep carrying it) are untouched.
--      No row here can already be prefixed: the prefixed form does not exist
--      anywhere before this statement runs.
ALTER TABLE "PhoneOtpChallenge" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'login';

UPDATE "PhoneOtpChallenge"
SET "liveKey" = 'login:' || "liveKey"
WHERE "liveKey" IS NOT NULL;
