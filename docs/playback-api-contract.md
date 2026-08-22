# Playback API Contract

Canonical contract for the three routes a client needs to discover and play a
video: `GET /videos/feed`, `GET /videos/:id`, and the two playback routes
`GET /videos/:id/playback` (authorization) and `GET /videos/:id/stream`
(local media bytes).

Last changed by the work unit **"ANONYMOUS FREE-EPISODE PLAYBACK"**, which
made the two playback routes **optional-auth** so a signed-out guest can watch
FREE content. Everything else about the contract — premium enforcement, the
entitlement model, admin access-tier overrides, HLS delivery — is unchanged.

---

## 1. The authorization matrix

Authorization is **backend-authoritative**. The client never decides; it asks
and is told.

| Caller                                                               | Content `accessTier` | Result                             |
| -------------------------------------------------------------------- | -------------------- | ---------------------------------- |
| Guest (no `Authorization` header)                                    | `free`               | **200** — playable source returned |
| Guest (no `Authorization` header)                                    | `premium`            | **403 `ENTITLEMENT_REQUIRED`**     |
| Authenticated, no entitlement                                        | `free`               | **200**                            |
| Authenticated, no entitlement                                        | `premium`            | **403 `ENTITLEMENT_REQUIRED`**     |
| Authenticated, active entitlement                                    | `premium`            | **200**                            |
| **Any** caller supplying an invalid / expired / malformed credential | any                  | **401 `INVALID_ACCESS_TOKEN`**     |

Two properties of that table are load-bearing and are asserted directly in
`test/videos.e2e-spec.ts`:

- **No token ≠ invalid token.** A missing `Authorization` header is a valid
  anonymous request. A header that is _present but unusable_ is an
  authentication failure and stays one — it is never downgraded to a guest.
- **The two `premium` refusals are byte-identical.** A guest and a signed-in
  non-entitled user receive exactly the same status, code and message, so the
  response reveals nothing about whether the caller had a session.

### Why `ENTITLEMENT_REQUIRED` and not a new guest-specific error

A guest cannot hold an entitlement, so "an active entitlement is required" is
truthful for them, and reusing the existing code keeps **one** stable refusal
contract for premium content instead of two that could drift. A client that
wants to show "Sign in" rather than "Subscribe" already knows locally whether
it holds a token — that is a UI decision, not an authorization one, and it
does not need the server to leak account state to make it.

---

## 2. Optional auth: exactly what each header state does

Implemented by `OptionalJwtAuthGuard`
(`src/auth/guards/optional-jwt-auth.guard.ts`), a subclass of `JwtAuthGuard`
that reuses its inherited, single-source-of-truth token parsing and
verification. It adds no JWT handling of its own.

| `Authorization` header                            | Outcome                                                |
| ------------------------------------------------- | ------------------------------------------------------ |
| absent                                            | anonymous — `request.user` undefined, handler proceeds |
| present but empty / whitespace only               | anonymous (no credential was supplied)                 |
| `Bearer <valid unexpired token>`                  | authenticated — `request.user` attached                |
| `Bearer <expired token>`                          | **401 `INVALID_ACCESS_TOKEN`**                         |
| `Bearer <bad signature / wrong secret / garbage>` | **401 `INVALID_ACCESS_TOKEN`**                         |
| `Bearer <valid token, no `sub` claim>`            | **401 `INVALID_ACCESS_TOKEN`**                         |
| `Bearer ` / `Bearer` (no token)                   | **401 `INVALID_ACCESS_TOKEN`**                         |
| `Token …`, `Basic …`, any non-Bearer scheme       | **401 `INVALID_ACCESS_TOKEN`**                         |

`JwtAuthGuard`'s own behavior is **unchanged**: every route that used it before
still rejects every one of the above except a valid token. Only routes that
explicitly name `OptionalJwtAuthGuard` in `@UseGuards()` behave differently, and
today that is exactly two: `/videos/:id/playback` and `/videos/:id/stream`.

---

## 3. What decides `free` vs `premium`

The single authoritative resolver is `resolveAccessTier`
(`src/entitlements/entitlement.constants.ts`). An explicit
`Video.accessTierOverride` of `"free"` or `"premium"` — set through the
admin-guarded `PATCH /admin/media/:id/access-tier` — always wins. Only a row
with a `null` override falls back to the historical
`episodeNumber > FREE_EPISODE_LIMIT` default, and after the 11F-4 backfill
every real row carries an explicit value, so that fallback is null-safety, not
policy.

**Episode number never decides access on its own.** The same resolver feeds
all four consumers, so they cannot disagree:

- the authorization gate (`VideosController#enforceEntitlementGate`)
- the public `VideoResponseDto.accessTier` field
- `SeriesPublicDto.hasPremiumEpisodes`
- `VideoPlaybackResponseDto.requiresAuthHeader` (see below)

`test/videos.e2e-spec.ts` proves this with deliberately inverted fixtures —
episode 1 forced `premium` (guest denied) and episode 99 forced `free` (guest
allowed) — outcomes no episode-number rule could produce.

---

## 4. `GET /videos/:id/playback`

Auth: **optional**. Rate limit: `VIDEO_PLAYBACK_URL_RATE_LIMIT` (60/min,
per-IP — applies identically to anonymous callers).

Returns one of two shapes depending on how the row's media is stored. The
client is never told which storage backend served it.

### Legacy shape (`VideoPlaybackResponseDto`)

```jsonc
{
  "playbackUrl": "https://…", // presigned R2 GET URL, or the /stream URL
  "expiresAt": "2026-08-22T12:15:00.000Z",
  "requiresAuthHeader": false,
}
```

`requiresAuthHeader` tells the client whether it must attach
`Authorization: Bearer <accessToken>` **to the media request itself**:

| Storage            | `accessTier` | `requiresAuthHeader`                                                                 |
| ------------------ | ------------ | ------------------------------------------------------------------------------------ |
| R2 (presigned URL) | any          | `false` — the signature carries the authorization; adding a header would break SigV4 |
| local (`/stream`)  | `free`       | `false` — **changed by this work unit** (was hardcoded `true`)                       |
| local (`/stream`)  | `premium`    | `true` — unchanged                                                                   |

It is a function of the **content only**, never of the caller: the same video
yields the same value for a guest, a signed-in non-entitled user, and a
subscriber. It is a floor, not a prohibition — a client holding a valid token
may attach it to a `false` row and is still accepted.

The local-media `false` case is what makes guest playback actually work rather
than merely return 200: a guest told `true` has no token to attach and would
either send `Bearer undefined` or give up.

### HLS shape (`HlsPlaybackResponseDto`)

```jsonc
{
  "type": "hls",
  "masterUrl": "<HLS_GATEWAY_BASE_URL>/t/<token>/master.m3u8",
  "renditions": [
    {
      "quality": "360p",
      "width": 360,
      "height": 640,
      "url": "…/360p/index.m3u8",
    },
  ],
  "expiresAt": "2026-08-22T13:00:00.000Z",
}
```

Returned for a row with `processingState === 'ready'` and a valid
`hlsMasterKey`. The gateway token is content-bound and carries no user claim,
so the Worker needs **no bearer header** — the HLS path already worked for any
caller holding a valid token and needs no change to work for a guest. The
authorization gate still runs first: no token is minted for a caller who is
refused.

The shape carries no `requiresAuthHeader` field at all, because the token _is_
the authorization — there is nothing for a guest to attach and nothing that
could tell it to attach one. The playlist and segment URIs inside the returned
playlists are **relative**, so they resolve against the token-prefixed
`masterUrl` and inherit the token for every nested request; a guest's player
does not lose authorization mid-stream.

Because `getPlaybackUrl` and `tryBuildHlsPlaybackResponse` take a row and never
a caller, this branch is caller-independent by construction. That is asserted,
not merely argued: `test/videos.e2e-spec.ts` covers guest+FREE+HLS (a token is
really minted for an anonymous caller, for that exact row's prefix),
guest+PREMIUM+HLS (403, zero mint calls), and a malformed credential on a FREE
HLS row (401, zero mint calls).

### Errors

| Status | Code                                | When                                                                     |
| ------ | ----------------------------------- | ------------------------------------------------------------------------ |
| 401    | `INVALID_ACCESS_TOKEN`              | a credential was supplied and is unusable                                |
| 403    | `ENTITLEMENT_REQUIRED`              | premium content, caller holds no active entitlement (guest or signed-in) |
| 404    | `VIDEO_NOT_FOUND`                   | unknown id, or a row not in `lifecycleState: published`                  |
| 409    | `MEDIA_PLAYBACK_SOURCE_UNAVAILABLE` | published row with neither storage source                                |
| 500    | `HLS_GATEWAY_NOT_CONFIGURED`        | qualifying HLS row with gateway config unset                             |

---

## 5. `GET /videos/:id/stream`

Auth: **optional**. Rate limit: `VIDEO_STREAM_RATE_LIMIT` (120/min, per-IP —
tightened from the app-wide 300/min default in the same change, for every
caller, because this route does real filesystem I/O and can stream a whole
episode per request). Serves local `STORAGE_ROOT` media with HTTP Range
support (`206` with `Content-Range`, or a full `200`).

Runs the **same** `enforceEntitlementGate` as `/playback`, before any
filesystem access — the two routes share one implementation precisely so a
caller can never obtain through one what the other refuses.

This route had to become optional-auth as well: for local-storage rows it _is_
the media endpoint, so a guest authorized at `/playback` but refused here
would be an authorization success with no bytes behind it.

- Guest + `free` → **200/206**, real bytes.
- Guest + `premium` → **403 `ENTITLEMENT_REQUIRED`** — enforced here, not only
  at `/playback`.
- Invalid/expired credential → **401**, even for free content.

---

## 6. `GET /videos/feed`, `GET /videos/:id`

Unauthenticated, unchanged. Both carry `accessTier` on every row — the same
value the gate enforces — so a guest-first client can render the catalog and
know which episodes will play before it asks.

---

## 7. Storage security

Nothing about this work unit widens storage exposure:

- **R2 stays private.** Access is still only ever a short-lived presigned GET
  URL minted per request, after authorization. No bucket or object ACL changes.
- **HLS stays behind the Worker**, gated by a short-TTL, prefix-scoped,
  HMAC-signed token. Unchanged.
- **Local `STORAGE_ROOT`** is not a public bucket. Bytes are reachable only
  through `/videos/:id/stream`, which resolves the path through
  `resolveSafeStoragePath` (traversal-proof), requires
  `lifecycleState: published`, and re-runs the tier/entitlement gate on every
  single request. What changed is _who_ passes that gate for FREE rows — the
  gate itself did not weaken.

The net new exposure is exactly the product requirement: the bytes of a
published, authoritatively-FREE episode are fetchable by id without a session.
Premium bytes are not.

**Abuse posture, stated honestly.** Dropping the token requirement removes a
thin barrier, not a real one — one `/auth/register` call already yielded a
token that could stream at the full app-wide 300/min. Both playback routes now
carry explicit per-IP ceilings (60/min for `/playback`, 120/min for `/stream`),
which is a net tightening for anonymous _and_ authenticated callers alike. It
is not a complete defense: `ThrottlerGuard` keys on client IP, so an attacker
rotating source addresses is unbounded by it and legitimate users behind one
NAT share a bucket. Bandwidth-level protection for free media belongs at the
CDN/edge, not in this process.

**Id enumeration.** A guest can now distinguish 404 from 403/200 on
`/playback` where they previously got a blanket 401. This is not new
information: `GET /videos/feed` and `GET /videos/:id` are already fully public
and expose exactly the same set of published rows.
