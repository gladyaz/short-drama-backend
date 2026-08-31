# Series cover artwork (source assets)

The four real Red Panda series covers, as REVIEWABLE files. `npm run
covers:ingest -- --apply` copies each one into the `local` storage driver's
object root and points the matching `Series.coverImageKey` at it.

## Filenames

The file stem must be the backend's own `Series.id` — that is the entire
mapping, and there is no table anywhere that could drift from it.

| File | Series | Genre |
|---|---|---|
| `series-101.webp` | Hidup Bahagiaku Bersama Sang Permaisuri | Romance |
| `series-104.webp` | Malapetaka Datang: Benteng Bergerakku | Action |
| `series-010.webp` | Kue Gulung Kaya Raya: Kedaiku Menembus Waktu | Comedy |
| `series-105.webp` | Hati Yin yang Jahat: Antagonis Serang Habis-habisan | Drama |

Adding a file for a series that has none, or replacing one, needs no code
change. Deleting one is also safe: the ingest reports that series as `skipped`
and the app falls back to the branded initial tile it already shows for a
series with no cover.

## Format

Accepted: JPEG, PNG, WebP — the same closed allow-list
`series-cover.constants.ts` enforces for admin uploads, checked here from each
file's own leading bytes rather than its extension. No SVG (a script-execution
surface). Ceiling is `MAX_SERIES_COVER_UPLOAD_BYTES` (10 MiB); these are 41-89 KB.

**600 x 900, 2:3 portrait** — the ratio the app's Discover grid uses
(`POSTER_ASPECT_RATIO = 2 / 3`). The tile is never rendered much wider than
300 px, so a larger file only costs bandwidth.

## Provenance

These are the production covers for exactly these four series, carrying the
original Mandarin title lockup the app itself displays. They are byte-identical
to the four the public marketing site ships in its own `public/posters/`, which
were centre-cropped from the taller source covers that ship beside the episode
files in the company library (`VideoDracin/短剧下载/<n>-<title>/`, whose folder
numbers are these same series ids).

The duplication with the website is deliberate rather than an oversight. A
backend checkout cannot depend on a sibling repository's path existing, and the
website cannot read them from R2 — the bucket is private and reaches clients
only as expiring presigned URLs. Both repos therefore commit the same four
files, and both document why.

## What must not go here

Artwork from another short-drama app, stock photography standing in for a real
drama, AI-generated art presented as a real series cover, or a frame extracted
from an episode. A poster is a claim about what a drama looks like.
