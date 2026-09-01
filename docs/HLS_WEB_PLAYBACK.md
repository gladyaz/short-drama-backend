# HLS Web Playback

How an HLS-ready episode reaches a **browser**, and what had to change for it
to work at all. Native (iOS/Android) playback is unaffected by everything on
this page — see `docs/HLS_TRANSCODE_WAVE.md` for the pipeline that produces the
media, and `docs/playback-api-contract.md` for the response shape.

---

## 1. Why the browser was a special case

The delivery gateway (`workers/hls-gateway/`) was built for native players.
AVPlayer (iOS) and Media3/ExoPlayer (Android) fetch a manifest and its segments
as **plain HTTP requests**. They are not a web page, they have no origin, and
CORS does not apply to them. So the Worker shipped with no `Access-Control-*`
headers, deliberately and correctly.

A browser is the opposite on both counts, and both had to be fixed:

| | Native | Browser |
|---|---|---|
| Can it play `.m3u8`? | Yes, platform engine | **Safari only.** Chrome and Firefox cannot. |
| How does it fetch segments? | Plain HTTP | `fetch`/XHR from the page's origin — **CORS applies** |

Fixing only one of them fixes nothing: an HLS engine with no CORS is refused at
the first manifest request, and CORS with no HLS engine has nothing to request.

---

## 2. Gateway CORS (`CORS_ALLOWED_ORIGINS`)

Implemented in `workers/hls-gateway/src/cors.ts`. Four rules, all enforced by
construction rather than by operator discipline:

1. **Opt-in, absent by default.** Unset or empty ⇒ not one `Access-Control-*`
   header is emitted, byte-identical to the Worker's original behaviour. Every
   native consumer is unaffected whether it is set or not.
2. **Never `*`.** The only value ever echoed is one that exactly matched a
   configured entry. A literal `*` is accepted as a list *entry* and grants
   nothing, because no browser ever sends `Origin: *`. These are private media
   objects behind a signed token; a wildcard is not representable here.
3. **Always `Vary: Origin`** whenever the allow-list is configured — including
   for a *refused* origin, since "this response had no ACAO" is itself an
   origin-dependent answer.
4. **CORS is applied on the way out, never stored.** The object written to the
   §9a cache is the CORS-free response; `withCors` rebuilds a fresh response
   per request. One origin's `Access-Control-Allow-Origin` can therefore never
   be replayed to another out of a cache whose key has no origin component.

Configure it in `wrangler.toml` (see `wrangler.toml.example`) as exact origins,
comma-separated, no wildcards and no trailing slash:

```toml
[vars]
CORS_ALLOWED_ORIGINS = "http://localhost:8082,https://app.example.com"
```

`OPTIONS` preflights from an allow-listed origin are answered `204` **without
consulting the playback token**. That is deliberate: a preflight carries no
credentials and reads no bytes, so making its status depend on token validity
would build a token-validity oracle and buy nothing. The real request that
follows is still fully verified by the Worker's unchanged request order.

### Verifying a deployment

```bash
MASTER=$(curl -s "$API/videos/<id>/playback" | jq -r .masterUrl)

curl -sD- -o/dev/null -H 'Origin: http://localhost:8082' "$MASTER"   # expect access-control-allow-origin
curl -sD- -o/dev/null -H 'Origin: https://not-listed.test' "$MASTER" # expect NO allow-origin, but Vary: Origin
curl -sD- -o/dev/null "$MASTER"                                      # native shape: no allow-origin at all
```

---

## 3. The browser HLS engine

`src/services/videos/web-hls.web.ts` in the mobile repo, with a native no-op
sibling `web-hls.ts`. **Metro resolves them per platform**, so `hls.js` is
never bundled into the iOS or Android app — `web-hls.test.ts` asserts that the
native half does not import it.

- `canPlayHlsInThisRuntime()` — true if `Hls.isSupported()` (Chrome/Firefox via
  MediaSource) **or** the browser plays HLS natively (Safari).
- `attachWebHlsEngine(container, masterUrl, onFatalError)` — attaches `hls.js`
  to the `<video>` inside `container` and returns a detach function, or `null`
  meaning "nothing attached, leave the element alone".

`null` is returned — correctly, not as an error — for Safari (its own engine is
already handling `<video src>`; attaching hls.js would be a downgrade), for an
unsupported browser, and for a not-yet-mounted element.

`expo-video`'s `VideoView` does not expose its DOM node, so the element is
found with a `querySelector` **scoped to the container** the feed item already
renders. Never `document.querySelector`: the feed mounts several items at once
and a document-wide lookup would attach one item's engine to a neighbour's
element.

When hls.js fails fatally, `onFatalError` flips the item onto the response's
MP4 `fallback` rather than leaving a black frame.

---

## 4. What a browser actually falls back to

A browser that cannot play HLS is not broken — it plays the MP4. That is the
whole point of the `fallback` field documented in
`docs/playback-api-contract.md`: the same progressive source the episode served
before it was transcoded. The decision lives in one place,
`resolvePlaybackSource` (`src/services/videos/video-service.ts`), which takes
both the operator kill switch and this runtime's actual HLS capability.

---

## 5. Web playback evidence

Captured against the deployed dev gateway with real Chrome (Playwright,
`channel: 'chrome'`), playing `video-104-01` — a real transcoded episode:

- `master.m3u8` → `200`, `content-type: application/vnd.apple.mpegurl`,
  `access-control-allow-origin: http://localhost:8082`
- `360p/index.m3u8` **and** `720p/index.m3u8` → `200`, both with ACAO
- `720p/init.mp4` → `200`, `video/mp4`; 18× `seg_*.m4s` → `200`,
  `video/iso.segment`; `360p/seg_00000.m4s` → `200`
- element state: `readyState: 4`, `videoWidth/Height: 720×1280`,
  `duration: 123.33`, `paused: false`, time advancing
- seek to `60` → resumed at `63.34`
- zero console errors from the player (the only console error was the
  harness's own missing favicon)

### Adaptive bitrate

Same master, same code, two network conditions — the variant choice differs:

| Condition | Level chosen |
|---|---|
| Unthrottled | level 2 — 720×1280 @ 3 565 800 bps |
| 400 kbps / 200 ms | level 0 — 360×640 @ 1 045 800 bps |

Each rendition also decodes independently via `ffprobe` against its own
gateway-served variant playlist (360p/540p/720p, all 123.33 s, h264 + aac), so
"adaptive" here means three separately-playable renditions plus an observed,
bandwidth-driven switch — not merely the existence of a master playlist.

---

## 6. Android handset QA (owner-performed)

Native Android needs **none** of the CORS or hls.js work above — Media3/ExoPlayer
fetches the manifest and segments as plain HTTP. What it does need is a real
handset: an emulator exercises the same ExoPlayer code path but not hardware
decode, real orientation, or a real network, so an emulator run cannot promote
this verdict past PARTIAL.

Prerequisites: the backend reachable from the phone (`PUBLIC_BASE_URL` must be
the LAN IP, not `localhost`), and the phone on the same Wi-Fi.

```bash
# 1. Backend, bound to the LAN IP the phone will use
cd /Users/gladyaz/red-panda-backend-hls
#    .env: PUBLIC_BASE_URL=http://<mac-lan-ip>:3010
npm run build && node dist/main

# 2. Mobile, pointed at that same host
cd /Users/gladyaz/red-panda-mobile-hls
#    .env: EXPO_PUBLIC_API_BASE_URL=http://<mac-lan-ip>:3010
npx expo run:android          # a dev build; Expo Go cannot host expo-video

# 3. Confirm the phone can actually reach the API before testing playback
adb shell curl -s -o /dev/null -w '%{http_code}\n' http://<mac-lan-ip>:3010/health
```

Then, signed OUT (clean guest — clear app data first):

| # | Step | Expect |
|---|---|---|
| 1 | Open Home | Feed loads with no sign-in prompt |
| 2 | Let the first **series-104** episode play | Video starts, **audio plays**, no black frame |
| 3 | Check orientation | series-104 is portrait 720×1280 — fills the frame, not letterboxed |
| 4 | Scrub the progress bar | Seek lands and resumes |
| 5 | Tap to pause, tap to resume | Both take effect immediately |
| 6 | Swipe to the next episode | Previous stops, next autoplays — exactly one video playing |
| 7 | Swipe back | Previous episode resumes, still exactly one playing |
| 8 | Open a **series-105** episode (MP4, not transcoded) | Plays — proves the MP4 path is untouched |
| 9 | Watch for a login screen at any point | Must never appear |

To confirm it is genuinely HLS rather than the MP4 fallback, watch the request
log while step 2 runs — a `master.m3u8` followed by a `<rung>/index.m3u8` and
`seg_*.m4s` requests is HLS; a single long-lived request to `/source` or
`/stream` is the fallback.

To exercise the fallback deliberately, set
`EXPO_PUBLIC_HLS_PLAYBACK_ENABLED=false` and rebuild: the same episode must
still play, now via MP4. That is the rollback switch, and it is only real
because the backend now ships `fallback`.
