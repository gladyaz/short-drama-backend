# short-drama-backend

Phase 5A: a minimal NestJS backend for the mobile short-drama app. It exposes
company video metadata and securely streams local MP4 files with HTTP
Range-request support, so the mobile app can move off the temporary Python
HTTP server.

## Architecture

```
mobile app (Expo/React Native)  -->  NestJS backend  -->  local company storage (STORAGE_ROOT)
```

- The backend never copies, moves, or renames company video files. It reads
  them in place from `STORAGE_ROOT` and streams bytes on request.
- Each video's `storageKey` is a path relative to `STORAGE_ROOT` (e.g.
  `短剧下载/10-雨夜校花（34集）/01.mp4`), never an absolute filesystem path.
  The backend resolves `storageKey` against `STORAGE_ROOT` at request time and
  rejects any resolved path that would escape the storage root.
- **Final MP4 files already contain embedded Indonesian subtitles.** This
  phase does no subtitle processing, transcription, translation, or dubbing —
  the mobile app plays the final MP4 as-is and must not request separate
  subtitle tracks or render subtitle overlays.
- No database, no authentication, no uploads. Video metadata is a small
  hardcoded list (`src/videos/videos.data.ts`) pointing at real files that
  were verified to exist during read-only inspection of `STORAGE_ROOT`.

## Environment variables

| Variable          | Purpose                                                                 |
| ------------------ | ------------------------------------------------------------------------ |
| `PORT`             | Port the server listens on (binds `0.0.0.0` so a simulator/device on the same network can reach it) |
| `PUBLIC_BASE_URL`  | Base URL used to build each video's `playbackUrl`                        |
| `STORAGE_ROOT`     | Absolute path to the company video storage folder (read-only)            |
| `CORS_ORIGINS`     | Comma-separated list of allowed origins (e.g. the Expo dev server)        |

Configuration is validated at startup: the app refuses to start if any
required variable is missing, or if `STORAGE_ROOT` does not exist / is not a
directory, with a clear error message.

### Create your `.env`

```bash
cp .env.example .env
```

Then edit `.env` with real local values, for example:

```
PORT=3000
PUBLIC_BASE_URL=http://localhost:3000
STORAGE_ROOT=/absolute/path/to/your/company-video-storage
CORS_ORIGINS=http://localhost:8081
```

For testing from a physical device on the same Wi-Fi network, set
`PUBLIC_BASE_URL` to your Mac's LAN IP instead of `localhost`
(e.g. `http://192.168.1.23:3000`).

`.env` is git-ignored and must never be committed — it contains the real,
machine-specific `STORAGE_ROOT` path. `.env.example` holds only generic
placeholder values and is safe to commit.

## Running the server

```bash
npm install
npm run start:dev   # watch mode
# or
npm run start        # single run
```

On startup you should see logs confirming the port, public base URL, and CORS
origins — and an immediate, readable error if `STORAGE_ROOT` is misconfigured.

## How videos are mapped

`src/videos/videos.data.ts` hardcodes a small list of `VideoRecord`s. Each
record's `storageKey` is relative to `STORAGE_ROOT`. At request time,
`VideosService` resolves `storageKey` against `STORAGE_ROOT`, confirms the
result stays inside the storage root (rejecting any path traversal), and
confirms the file exists before streaming it. `playbackUrl` in every API
response is generated dynamically as:

```
${PUBLIC_BASE_URL}/videos/${id}/stream
```

The mobile app never receives an absolute filesystem path — only the relative
`storageKey` (for reference) and the generated `playbackUrl`.

## API

### `GET /health`

```json
{ "status": "ok", "service": "short-drama-backend" }
```

### `GET /videos/feed`

Returns all registered video metadata records.

### `GET /videos/:id`

Returns one video's metadata, or a structured 404:

```json
{ "statusCode": 404, "code": "VIDEO_NOT_FOUND", "message": "Video not found" }
```

### `GET /videos/:id/stream`

Streams the underlying MP4 with Range support. Responds `206 Partial Content`
with `Content-Range` when a `Range` header is supplied, or a full `200` with
the whole file otherwise. Never loads the full file into memory — it streams
from disk with `fs.createReadStream`.

Error codes used across the API: `VIDEO_NOT_FOUND`, `MEDIA_FILE_NOT_FOUND`,
`INVALID_MEDIA_RANGE`, `INVALID_STORAGE_PATH`. Responses never include stack
traces or absolute filesystem paths.

## Testing

```bash
npm run test       # unit tests (fs is mocked — no real video files needed)
npm run test:e2e   # e2e tests (boots the real app against your local .env,
                    # including a live Range request against a real company MP4)
npm run test:cov   # coverage
```

### Manual testing

```bash
curl http://localhost:3000/health

curl http://localhost:3000/videos/feed

curl http://localhost:3000/videos/video-001

curl -I http://localhost:3000/videos/video-001/stream

curl -i \
  -H "Range: bytes=0-1023" \
  http://localhost:3000/videos/video-001/stream
```

The last command should return `HTTP/1.1 206 Partial Content` with
`Content-Range: bytes 0-1023/<file size>` and `Accept-Ranges: bytes`.

You can also open a `playbackUrl` from `GET /videos/feed` directly in a
browser to confirm the real company video plays and that seeking (which
relies on Range requests) works.

## Why company videos are never committed

`STORAGE_ROOT` points at real, company-owned Mandarin drama video files
outside this repository. The backend only ever reads from that path — it
never copies, moves, renames, or writes into it. `.gitignore` excludes
`*.mp4`, `*.mov`, `*.mkv`, and common storage folder names so that real media
can never be accidentally committed. Only source code and small, hardcoded
metadata (relative `storageKey` values, titles, captions) are tracked in git.

## What's next

Phase 5B will connect the mobile app (Expo/React Native) to this backend,
replacing the temporary Python HTTP server and wiring `storageKey` /
`playbackUrl` through the existing video service layer.
